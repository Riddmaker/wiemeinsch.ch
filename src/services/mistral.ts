import { Mistral } from "@mistralai/mistralai";
import {
  ConnectionError,
  MistralError,
  RequestTimeoutError,
} from "@mistralai/mistralai/models/errors";

/**
 * Gemeinsamer Mistral-Unterbau für Linter & Translation.
 * Modell-IDs kommen ausschliesslich aus Env-Vars — nie im Code hartcodieren
 * der Key wird nie geloggt (HABIT 1).
 */

/** Timeout pro HTTP-Request an die Mistral-API. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Fehlende/leere Env-Konfiguration — Programmierfehler, kein Laufzeit-Flackern. */
export class MistralConfigError extends Error {
  constructor(variable: string) {
    super(`Missing required environment variable: ${variable}`);
    this.name = "MistralConfigError";
  }
}

/**
 * Einheitlicher Fehler für "AI-Service nicht verfügbar/nutzbar" (Entscheid E8:
 * fail-closed — Aufrufer blockieren den Publish und zeigen eine klare Meldung).
 * Die Message ist bewusst generisch; Details bleiben in `cause` für Server-Logs
 * und erreichen nie den Client (P6 Stolperstein: keine rohen LLM/API-Fehler
 * durchreichen).
 */
export class MistralUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MistralUnavailableError";
  }
}

function requireEnv(variable: string): string {
  const value = process.env[variable];
  if (!value) {
    throw new MistralConfigError(variable);
  }
  return value;
}

export type MistralModels = {
  moderation: string;
  linter: string;
  translate: string;
};

export function getMistralModels(): MistralModels {
  return {
    moderation: requireEnv("MISTRAL_MODERATION_MODEL"),
    linter: requireEnv("MISTRAL_LINTER_MODEL"),
    translate: requireEnv("MISTRAL_TRANSLATE_MODEL"),
  };
}

// Client-Singleton — gleiches Muster wie src/lib/prisma.ts (Hot-Reload-sicher).
const createClient = () =>
  new Mistral({
    apiKey: requireEnv("MISTRAL_API_KEY"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    // Retries übernimmt withOneRetry (deterministisch: genau eine Stufe),
    // nicht die SDK-interne Backoff-Schleife.
    retryConfig: { strategy: "none" },
  });

const globalForMistral = globalThis as unknown as {
  mistral?: Mistral;
};

export function getMistralClient(): Mistral {
  const client = globalForMistral.mistral ?? createClient();
  if (process.env.NODE_ENV !== "production") {
    globalForMistral.mistral = client;
  }
  return client;
}

/** Transient = Verbindungs-/Timeout-Fehler, HTTP 429 oder 5xx. */
function isTransient(error: unknown): boolean {
  if (
    error instanceof ConnectionError ||
    error instanceof RequestTimeoutError
  ) {
    return true;
  }
  if (error instanceof MistralError) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

/**
 * Genau eine Retry-Stufe für transiente Fehler.
 * Jeder endgültige Fehlschlag wird auf MistralUnavailableError abgebildet.
 */
export async function withOneRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (firstError) {
    if (!isTransient(firstError)) {
      throw new MistralUnavailableError("Mistral API request failed", {
        cause: firstError,
      });
    }
    try {
      return await call();
    } catch (secondError) {
      throw new MistralUnavailableError("Mistral API request failed twice", {
        cause: secondError,
      });
    }
  }
}
