import { z } from "./zod";

/**
 * Schemas für die Civic-Linter-LLM-Antwort (Insecure-Output-Handling-Defense,
 * OWASP GenAI / P6.4): Die Antwort des LLM ist
 * untrusted Input und wird hart validiert, bevor irgendetwas damit passiert.
 * Ihr Freitext (`explanation`) wird im UI ausschliesslich als Text gerendert,
 * nie als HTML.
 *
 * Zwei Schemas mit klarer Rollenteilung:
 * - `linterWireSchema`: bewusst nur JSON-Schema-Grundtypen (Object/Array/
 *   String/Enum) — wird via `responseFormat` an die Mistral-API geschickt,
 *   wo exotischere Constraints (min/max) nicht garantiert unterstützt sind.
 * - `linterLlmResponseSchema`: das strikte Schema (Längen-Caps, Anzahl-Caps),
 *   mit dem die Antwort serverseitig validiert wird.
 */

/**
 * Grund-Codes (Beleidigung,
 * toxische Polemik/Rhetorik; INJECTION für Prompt-Injection-Versuche).
 * Das UI übersetzt die Codes über die messages/-Kataloge — der Code selbst
 * ist sprachneutral.
 */
export const LINTER_REASONS = [
  "RAGEBAIT",
  "BELEIDIGUNG",
  "POLEMIK",
  "DISKRIMINIERUNG",
  "DROHUNG",
  "INJECTION",
  "UNSACHLICH",
] as const;

export const linterReasonSchema = z.enum(LINTER_REASONS);
export type LinterReason = z.infer<typeof linterReasonSchema>;

/** Obergrenzen für die LLM-Antwort — alles darüber ist ungültig (Retry/E8). */
export const LINTER_MAX_FINDINGS = 20;
export const LINTER_MAX_QUOTE_LENGTH = 700;
export const LINTER_MAX_EXPLANATION_LENGTH = 400;

/** Wire-Format für `responseFormat` (nur Grundtypen, siehe oben). */
export const linterWireSchema = z.object({
  findings: z.array(
    z.object({
      quote: z.string(),
      reason: linterReasonSchema,
      explanation: z.string(),
    }),
  ),
});

/** Striktes Validierungs-Schema für die tatsächliche LLM-Antwort. */
export const linterLlmResponseSchema = z.object({
  findings: z
    .array(
      z.object({
        /** Wörtliches Zitat des beanstandeten Satzes aus dem User-Content. */
        quote: z.string().min(1).max(LINTER_MAX_QUOTE_LENGTH),
        reason: linterReasonSchema,
        /** Begründung in der Sprache des Users; wird nur als Text gerendert. */
        explanation: z.string().min(1).max(LINTER_MAX_EXPLANATION_LENGTH),
      }),
    )
    .max(LINTER_MAX_FINDINGS),
});

export type LinterLlmResponse = z.infer<typeof linterLlmResponseSchema>;
