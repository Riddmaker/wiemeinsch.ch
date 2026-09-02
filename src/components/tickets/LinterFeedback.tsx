"use client";

import { useTranslations } from "next-intl";
import type { ClientFinding } from "@/services/content-pipeline";

/**
 * Civic-Linter-Feedback unter einem Feld (P7.4, Styleguide Art. 8):
 * Grund-Chip in Signalrot + Begründung als reiner Text (LLM-Output wird NIE
 * als HTML gerendert — OWASP Insecure Output Handling).
 */
export function LinterFeedback({ findings }: { findings: ClientFinding[] }) {
  const t = useTranslations("linter");

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="linter-feedback">
      {findings.map((finding, index) => (
        <div
          key={index}
          className="flex flex-col gap-1 border border-line border-t-2 border-t-signal bg-signal-bg px-4 py-2.5 font-mono text-xs"
        >
          <span className="font-bold uppercase tracking-wide text-signal">
            {t("chip", { reason: t(`reasons.${finding.reason}`) })}
          </span>
          {finding.explanation && (
            <span className="text-ink">{finding.explanation}</span>
          )}
        </div>
      ))}
      {/* Die Anfechtung (P12.2) steht einmal pro Einreichung beim Banner —
          nicht pro Feld: ein Entscheid, ein Fall in der Queue. */}
    </div>
  );
}
