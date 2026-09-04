import type { AppLocale } from "@/i18n/routing";
import { lintText, type LinterFinding } from "@/services/linter";

/**
 * Feldweise Linter-Orchestrierung für den Publish-Flow (P7.3, wiederverwendet
 * ab P9 für Statements): lintet mehrere Freitextfelder parallel und liefert
 * nur die beanstandeten Felder zurück. Fail-closed bleibt beim Aufrufer —
 * MistralUnavailableError propagiert unverändert (E8).
 */

/** Findings ohne interne Diagnose-Felder — das Format fürs UI (P7.4). */
export type ClientFinding = {
  from: number;
  to: number;
  reason: LinterFinding["reason"];
  explanation?: string;
  /** Neuformulierung; fehlt, wenn der Satz keinen sachlichen Kern hat. */
  suggestion?: string;
};

export type BlockedFields<Field extends string> = Partial<
  Record<Field, ClientFinding[]>
>;

function toClientFinding(finding: LinterFinding): ClientFinding {
  return {
    from: finding.from,
    to: finding.to,
    reason: finding.reason,
    ...(finding.explanation ? { explanation: finding.explanation } : {}),
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
  };
}

export async function lintFields<Field extends string>(
  fields: Partial<Record<Field, string>>,
  textLocale: AppLocale,
  userLocale: AppLocale,
): Promise<BlockedFields<Field>> {
  const entries = (Object.entries(fields) as [Field, string][]).filter(
    ([, text]) => text.trim().length > 0,
  );
  const results = await Promise.all(
    entries.map(
      async ([field, text]) =>
        [field, await lintText({ text, textLocale, userLocale })] as const,
    ),
  );
  const blocked: BlockedFields<Field> = {};
  for (const [field, result] of results) {
    if (result.status === "blocked") {
      blocked[field] = result.findings.map(toClientFinding);
    }
  }
  return blocked;
}
