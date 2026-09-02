import { z } from "./zod";
import { linterReasonSchema } from "./linter";
import { statementDraftSchema } from "./statement";
import { ticketDraftSchema } from "./ticket";

/**
 * Moderations-Schemas (P12). Geteilt zwischen Client-Dialogen und Server
 * Actions (Single Source of Truth) — serverseitig die Bypass-Schutzschicht
 * vor jeder Mutation. `strictObject` überall: eingeschleuste Felder (etwa ein
 * fremder `reporterId` oder ein `status`) lassen die Validierung scheitern.
 */

/**
 * Fester Melde-Grund-Katalog (User-Entscheid 30.08.2026): bewusst KEIN
 * Freitext — er wäre eine Fläche für Beschimpfungen und Prompt-Injection
 * Richtung Admin-Ansicht und macht die Queue unzählbar.
 */
export const REPORT_REASONS = [
  "BELEIDIGUNG",
  "POLEMIK",
  "SPAM",
  "FALSCHINFORMATION",
  "KEIN_POLITISCHER_BEZUG",
  "PERSOENLICHE_DATEN",
] as const;

export const reportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.output<typeof reportReasonSchema>;

/** Meldbare Inhalte: publizierte Tickets und Statements . */
export const reportTargetTypeSchema = z.enum(["TICKET", "STATEMENT"]);
export type ReportTargetType = z.output<typeof reportTargetTypeSchema>;

/** cuid-Länge; die Existenz prüft die Action zusätzlich gegen die DB. */
const contentIdSchema = z.string().min(1).max(40);

export const reportInputSchema = z.strictObject({
  targetType: reportTargetTypeSchema,
  targetId: contentIdSchema,
  reason: reportReasonSchema,
});

export type ReportInput = z.output<typeof reportInputSchema>;

/**
 * Anfechtung: der Client schickt NUR den Entwurf, nie die Linter-Findings —
 * die würde er sonst frei erfinden können. Der Server lintet selbst nach und
 * speichert die echten Gründe (siehe actions/moderation.ts).
 */
export const appealInputSchema = z.union([
  z.strictObject({ kind: z.literal("ticket"), draft: ticketDraftSchema }),
  z.strictObject({ kind: z.literal("statement"), draft: statementDraftSchema }),
]);

export type AppealInput = z.output<typeof appealInputSchema>;

/** Ein serverseitig ermitteltes Finding, wie es im Case gespeichert wird. */
const storedFindingSchema = z.strictObject({
  field: z.string().min(1).max(40),
  reason: linterReasonSchema,
  explanation: z.string().max(400).optional(),
});

const storedFindingsSchema = z.array(storedFindingSchema).max(60);

/**
 * `ModerationCase.blockedContent` bei APPEAL. Wird beim Freigeben erneut
 * validiert — die DB-Zeile ist zwar serverseitig entstanden, aber der
 * Publish-Weg bekommt trotzdem nur geprüfte Daten (Defense in Depth).
 */
export const storedAppealSchema = z.union([
  z.strictObject({
    kind: z.literal("ticket"),
    draft: ticketDraftSchema,
    findings: storedFindingsSchema,
  }),
  z.strictObject({
    kind: z.literal("statement"),
    draft: statementDraftSchema,
    findings: storedFindingsSchema,
  }),
]);

export type StoredAppeal = z.output<typeof storedAppealSchema>;
export type StoredFinding = z.output<typeof storedFindingSchema>;

/** Entscheid-Codes im Präfix von `resolutionNote` (kein zusätzliches Feld nötig). */
export const CASE_DECISIONS = [
  "DISMISSED",
  "DEPUBLISHED",
  "APPEAL_APPROVED",
] as const;

export type CaseDecision = (typeof CASE_DECISIONS)[number];

export const RESOLUTION_NOTE_MAX = 500;

/** Eingabe jeder Admin-Entscheidung: Case + optionale Notiz. */
export const caseDecisionInputSchema = z.strictObject({
  caseId: contentIdSchema,
  note: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(RESOLUTION_NOTE_MAX).optional(),
  ),
});

export type CaseDecisionInput = z.output<typeof caseDecisionInputSchema>;

/** Filter der Admin-Queue (aus searchParams, daher tolerant validiert). */
export const queueFilterSchema = z.object({
  status: z.enum(["OPEN", "RESOLVED"]).catch("OPEN"),
  type: z.enum(["ALL", "REPORT", "APPEAL"]).catch("ALL"),
});

export type QueueFilter = z.output<typeof queueFilterSchema>;

/** Entscheid-Präfix und Notiz aus `resolutionNote` trennen (Anzeige im Admin-UI). */
export function parseResolutionNote(value: string | null): {
  decision: CaseDecision | null;
  note: string | null;
} {
  if (!value) {
    return { decision: null, note: null };
  }
  const separator = value.indexOf(":");
  const head = separator === -1 ? value : value.slice(0, separator);
  const tail = separator === -1 ? "" : value.slice(separator + 1).trim();
  const decision = (CASE_DECISIONS as readonly string[]).includes(head)
    ? (head as CaseDecision)
    : null;
  return {
    decision,
    note: decision ? tail || null : value,
  };
}

/** Gegenstück zu parseResolutionNote — schreibt den Präfix. */
export function formatResolutionNote(
  decision: CaseDecision,
  note?: string,
): string {
  return note ? `${decision}: ${note}` : decision;
}
