"use client";

import { useTranslations } from "next-intl";
import type { ChangeRequestLinterFields } from "@/actions/change-requests";
import { ConstrainedEditor } from "@/components/editor/ConstrainedEditor";
import type { LinterRange } from "@/components/editor/linter-highlight";
import { LinterFeedback } from "@/components/tickets/LinterFeedback";
import {
  type ChangeRequestProposal,
  type ChangeRequestTextField,
} from "@/lib/validation/change-request";
import {
  FUNDING_MAX,
  PROBLEM_MAX,
  PROBLEM_MIN,
  SOLUTION_MAX,
  SOLUTION_MIN,
  TITLE_MAX,
} from "@/lib/validation/limits";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";

/**
 * Editierbare Felder EINER Fassung eines Änderungsantrags — nur die Felder,
 * die der Antrag betrifft (E12). Geteilt zwischen der Übersetzungs-Preview
 * des Antragstellers und «Anpassen & übernehmen» des Ticket-Autors (E15),
 * damit beide exakt dieselben Limiten, Linter-Markierungen und Entwürfe
 * verwenden.
 */

export const DOC_FIELD_LIMITS: Record<
  "problem" | "solution" | "funding",
  { min: number; max: number }
> = {
  problem: { min: PROBLEM_MIN, max: PROBLEM_MAX },
  solution: { min: SOLUTION_MIN, max: SOLUTION_MAX },
  funding: { min: 0, max: FUNDING_MAX },
};

const DOC_FIELDS = ["problem", "solution", "funding"] as const;

export function toHighlights(
  findings: ChangeRequestLinterFields,
  field: ChangeRequestTextField,
): LinterRange[] {
  return (findings[field] ?? []).map((finding) => ({
    start: finding.from,
    end: finding.to,
    reason: finding.reason,
  }));
}

export function ProposalFields({
  fields,
  version,
  onFieldChange,
  findings,
  draftKey,
  editorKey,
  testIdPrefix,
  labelSuffix,
}: {
  fields: readonly ChangeRequestTextField[];
  version: ChangeRequestProposal;
  /**
   * Änderung EINES Feldes. Bewusst kein «ganze Fassung»-Callback: TipTap hält
   * den onUpdate-Handler aus dem ersten Render fest — ein Handler, der die
   * ganze Fassung aus der Closure zusammensetzt, würde andere, inzwischen
   * geänderte Felder zurücksetzen. Der Aufrufer aktualisiert funktional.
   */
  onFieldChange: (
    field: ChangeRequestTextField,
    value: string | ConstrainedDoc,
  ) => void;
  findings: ChangeRequestLinterFields;
  /** localStorage-Key je Feld (auch der React-Key des Editors). */
  draftKey: (field: ChangeRequestTextField) => string;
  /** Wechselt der Wert, startet der Editor neu (z.B. nach neuer Übersetzung). */
  editorKey: string;
  testIdPrefix: string;
  /** Zusatz im zugänglichen Namen, etwa die Sprache der Fassung. */
  labelSuffix?: string;
}) {
  const tTicket = useTranslations("ticketDetail");
  const tNew = useTranslations("ticketNew");

  const fieldLabel: Record<ChangeRequestTextField, string> = {
    title: tNew("titleLabel"),
    problem: tTicket("problem"),
    solution: tTicket("solution"),
    funding: tTicket("funding"),
  };
  const accessibleName = (field: ChangeRequestTextField) =>
    labelSuffix ? `${fieldLabel[field]} — ${labelSuffix}` : fieldLabel[field];

  return (
    <>
      {fields.includes("title") && (
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wide text-meta">
            {fieldLabel.title}
          </span>
          <input
            type="text"
            data-testid={`${testIdPrefix}-title`}
            aria-label={accessibleName("title")}
            maxLength={TITLE_MAX}
            value={version.title ?? ""}
            onChange={(event) => onFieldChange("title", event.target.value)}
            className="rounded-[2px] border-[1.5px] border-line bg-paper px-3 py-2 font-serif text-[15.5px] focus:border-ink focus:outline-none"
          />
          {findings.title && <LinterFeedback findings={findings.title} />}
        </label>
      )}

      {DOC_FIELDS.filter((field) => fields.includes(field)).map((field) => (
        <div key={field} className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wide text-meta">
            {fieldLabel[field]}
          </span>
          <ConstrainedEditor
            key={`${editorKey}-${field}`}
            name={draftKey(field)}
            label={accessibleName(field)}
            minChars={DOC_FIELD_LIMITS[field].min}
            maxChars={DOC_FIELD_LIMITS[field].max}
            initialContent={version[field]}
            onUpdate={(next) => onFieldChange(field, next as ConstrainedDoc)}
            highlights={toHighlights(findings, field)}
          />
          {findings[field] && <LinterFeedback findings={findings[field]} />}
        </div>
      ))}
    </>
  );
}
