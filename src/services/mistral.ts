import { Mistral } from "@mistralai/mistralai";
import {
  ConnectionError,
  MistralError,
  RequestTimeoutError,
} from "@mistralai/mistralai/models/errors";
import { errorFields, logEvent } from "@/lib/log";

/**
 * Gemeinsamer Mistral-Unterbau für Linter & Translation.
 * Modell-IDs kommen ausschliesslich aus Env-Vars — nie im Code hartcodieren
 * der Key wird nie geloggt (HABIT 1).
 */

/** Timeout pro HTTP-Request an die Mistral-API. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Gleichzeitige Mistral-Aufrufe pro Prozess (Code-Review 25.09.2026). Ein
 * einziger Ticket-Publish lintet bis zu 13 Felder parallel — mehrere davon
 * gleichzeitig liefen sonst in das Rate-Limit des Mistral-Kontos (429), und
 * fail-closed hiesse das «KI nicht verfügbar» für alle. Überzählige Aufrufe
 * warten kurz, statt zu scheitern.
 */
const MAX_CONCURRENT_CALLS = 6;

/** Pause vor dem einen Retry (+ Zufall), wenn die API keine vorgibt. */
function baseRetryDelayMs(): number {
  const configured = Number(process.env.MISTRAL_RETRY_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1_000;
}

/** Obergrenze für ein `Retry-After` der API — länger wartet kein Formular. */
const MAX_RETRY_AFTER_MS = 5_000;

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

let activeCalls = 0;
const waitingCalls: (() => void)[] = [];

async function withCallSlot<T>(call: () => Promise<T>): Promise<T> {
  if (activeCalls >= MAX_CONCURRENT_CALLS) {
    await new Promise<void>((resolve) => waitingCalls.push(resolve));
  }
  activeCalls += 1;
  try {
    return await call();
  } finally {
    activeCalls -= 1;
    waitingCalls.shift()?.();
  }
}

/**
 * Wartezeit vor dem Retry: ein `Retry-After` der API (in Sekunden, gedeckelt),
 * sonst die Basis-Pause plus bis zu 50 % Zufall — damit parallel gescheiterte
 * Aufrufe nicht im selben Moment erneut anklopfen.
 */
function retryDelayMs(error: unknown): number {
  if (error instanceof MistralError) {
    const header = Number(error.headers?.get("retry-after"));
    if (Number.isFinite(header) && header >= 0) {
      return Math.min(header * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  const base = baseRetryDelayMs();
  return base + Math.random() * base * 0.5;
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
 * Genau eine Retry-Stufe für transiente Fehler, mit Pause davor.
 * Jeder endgültige Fehlschlag wird auf MistralUnavailableError abgebildet —
 * und geloggt: Die Actions melden dem User nur «KI nicht verfügbar», der
 * Grund muss im Betrieb trotzdem sichtbar sein. `operation` benennt den
 * Aufruf im Log (z.B. «moderation», «linter», «translate»).
 */
export async function withOneRetry<T>(
  call: () => Promise<T>,
  operation = "call",
): Promise<T> {
  try {
    return await withCallSlot(call);
  } catch (firstError) {
    if (!isTransient(firstError)) {
      logEvent("error", "mistral.failed", {
        operation,
        attempts: 1,
        ...errorFields(firstError),
      });
      throw new MistralUnavailableError("Mistral API request failed", {
        cause: firstError,
      });
    }
    const delay = retryDelayMs(firstError);
    logEvent("warn", "mistral.retry", {
      operation,
      delayMs: Math.round(delay),
      ...errorFields(firstError),
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await withCallSlot(call);
    } catch (secondError) {
      logEvent("error", "mistral.failed", {
        operation,
        attempts: 2,
        ...errorFields(secondError),
      });
      throw new MistralUnavailableError("Mistral API request failed twice", {
        cause: secondError,
      });
    }
  }
}

/**
 * Marker um den Nutzertext im Prompt. Die Grenze ist pro Aufruf zufällig
 * (`randomUUID()` beim Aufrufer) — ein fester Marker liesse sich im Text
 * vorwegnehmen, um den Datenblock scheinbar zu beenden (OWASP GenAI LLM01).
 */
export function contentBoundary(
  kind: "BEGIN" | "END",
  boundary: string,
): string {
  return `${kind}_USER_CONTENT_${boundary}`;
}

export function wrapUserContent(text: string, boundary: string): string {
  return `${contentBoundary("BEGIN", boundary)}\n${text}\n${contentBoundary("END", boundary)}`;
}
