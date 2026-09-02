"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import {
  declineChangeRequest,
  mergeChangeRequest,
  type ChangeRequestLinterFields,
} from "@/actions/change-requests";
import { ConstrainedEditor } from "@/components/editor/ConstrainedEditor";
import { clearDraft } from "@/components/editor/drafts";
import type { LinterRange } from "@/components/editor/linter-highlight";
import { LinterFeedback } from "@/components/tickets/LinterFeedback";
import { useRouter } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { SOLUTION_MAX, SOLUTION_MIN } from "@/lib/validation/limits";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";

/**
 * Entscheid über einen Änderungsantrag (P10.3) — nur für den Original-Autor
 * gerendert; die Berechtigung prüft zusätzlich die Server Action.
 *
 * Übersetzungs-Preview beim Merge: Es werden die drei vom Antragsteller
 * freigegebenen Fassungen gezeigt (kein neuer AI-Aufruf, User-Entscheid P10);
 * der Autor darf jede editieren — editierte Fassungen durchlaufen beim
 * Übernehmen erneut den Civic-Linter.
 */

const subscribeNoop = () => () => {};

function mergeDraftKey(changeRequestId: string, locale: AppLocale): string {
  return `change-request-merge-${changeRequestId}-${locale}`;
}

function toHighlights(findings: ChangeRequestLinterFields): LinterRange[] {
  return (findings.solution ?? []).map((finding) => ({
    start: finding.from,
    end: finding.to,
    reason: finding.reason,
  }));
}

export function ChangeRequestDecision({
  changeRequestId,
  proposedVersions,
  isStale,
}: {
  changeRequestId: string;
  /** Die drei Fassungen des Antrags (Original + zwei Übersetzungen). */
  proposedVersions: Partial<Record<AppLocale, ConstrainedDoc>>;
  /** true, wenn die Lösung seit Antragstellung geändert wurde (P10.4). */
  isStale: boolean;
}) {
  const t = useTranslations("changeRequests");
  const tRoot = useTranslations();
  const locale = useLocale() as AppLocale;
  const router = useRouter();

  const isClient = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  const [mode, setMode] = useState<"idle" | "review">("idle");
  const [versions, setVersions] =
    useState<Partial<Record<AppLocale, ConstrainedDoc>>>(proposedVersions);
  const [findings, setFindings] = useState<
    Partial<Record<AppLocale, ChangeRequestLinterFields>>
  >({});
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "merge" | "decline">(null);

  const errorText = (code: string): string =>
    t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.invalid_input");

  const clearMergeDrafts = () => {
    for (const target of routing.locales) {
      clearDraft(mergeDraftKey(changeRequestId, target));
    }
  };

  const handleMerge = async () => {
    setErrorCode(null);
    setBusy("merge");
    try {
      const result = await mergeChangeRequest({
        changeRequestId,
        locale,
        versions,
      });
      if (!result.ok) {
        if (result.error === "linter") {
          setFindings(result.versions);
        } else {
          setErrorCode(result.error);
        }
        return;
      }
      clearMergeDrafts();
      setMode("idle");
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const handleDecline = async () => {
    setErrorCode(null);
    setBusy("decline");
    try {
      const result = await declineChangeRequest({ changeRequestId });
      if (!result.ok) {
        setErrorCode(result.error);
        return;
      }
      clearMergeDrafts();
      setMode("idle");
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const hasFindings = Object.keys(findings).length > 0;

  const staleWarning = isStale && (
    <p
      role="alert"
      data-testid="change-request-stale"
      className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
    >
      {t("staleWarning")}
    </p>
  );

  if (mode === "idle") {
    return (
      <div className="mt-4 flex flex-col gap-3">
        {errorCode && (
          <p
            role="alert"
            className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
          >
            {errorText(errorCode)}
          </p>
        )}
        {staleWarning}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            data-testid="change-request-review"
            onClick={() => setMode("review")}
            disabled={busy !== null}
            className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
          >
            {t("merge")}
          </button>
          <button
            type="button"
            data-testid="change-request-decline"
            onClick={() => void handleDecline()}
            disabled={busy !== null}
            className="rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:border-line disabled:text-meta"
          >
            {busy === "decline" ? t("declining") : t("decline")}
          </button>
        </div>
      </div>
    );
  }

  if (!isClient) {
    return null;
  }

  return (
    <div className="mt-4 flex max-w-[640px] flex-col gap-4">
      {errorCode && (
        <p
          role="alert"
          className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
        >
          {errorText(errorCode)}
        </p>
      )}
      {staleWarning}
      {hasFindings && (
        <p
          role="alert"
          className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
        >
          {t("linterBlockedMerge")}
        </p>
      )}

      <p className="text-[15px] leading-relaxed">{t("mergeIntro")}</p>

      {routing.locales.map((target) => {
        const version = versions[target];
        if (!version) {
          return null;
        }
        const versionFindings = findings[target] ?? {};
        return (
          <div key={target} className="flex flex-col gap-1.5">
            <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
              {tRoot(`localeSwitcher.${target}`)}
            </span>
            <ConstrainedEditor
              name={mergeDraftKey(changeRequestId, target)}
              label={`${t("proposedSolution")} — ${tRoot(`localeSwitcher.${target}`)}`}
              minChars={SOLUTION_MIN}
              maxChars={SOLUTION_MAX}
              initialContent={version}
              onUpdate={(next) => {
                setVersions((prev) => ({
                  ...prev,
                  [target]: next as ConstrainedDoc,
                }));
                setFindings((prev) => {
                  if (!prev[target]) {
                    return prev;
                  }
                  const nextFindings = { ...prev };
                  delete nextFindings[target];
                  return nextFindings;
                });
              }}
              highlights={toHighlights(versionFindings)}
            />
            {versionFindings.solution && (
              <LinterFeedback findings={versionFindings.solution} />
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setMode("idle")}
          disabled={busy !== null}
          className="rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:border-line disabled:text-meta"
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          data-testid="change-request-merge"
          onClick={() => void handleMerge()}
          disabled={busy !== null || hasFindings}
          className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
        >
          {busy === "merge" ? t("merging") : t("confirmMerge")}
        </button>
      </div>
    </div>
  );
}
