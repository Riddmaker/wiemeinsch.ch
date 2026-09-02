"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import {
  prepareChangeRequest,
  submitChangeRequest,
  type ChangeRequestLinterFields,
} from "@/actions/change-requests";
import { LoginHint } from "@/components/auth/LoginHint";
import { ConstrainedEditor } from "@/components/editor/ConstrainedEditor";
import { clearDraft, loadDraft, saveDraft } from "@/components/editor/drafts";
import type { LinterRange } from "@/components/editor/linter-highlight";
import { LinterFeedback } from "@/components/tickets/LinterFeedback";
import { useRouter } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { changeRequestDraftSchema } from "@/lib/validation/change-request";
import { SOLUTION_MAX, SOLUTION_MIN } from "@/lib/validation/limits";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";

/**
 * Änderungsantrag stellen (P10.1): Der Editor startet mit dem aktuellen
 * Lösungstext in der Lese-Sprache des Antragstellers; danach läuft exakt die
 * Pipeline von Ticket (P7) und Statement (P9) — Civic-Linter inline,
 * Übersetzungs-Preview in den zwei anderen Landessprachen, dann einreichen.
 */

// Client-Gate ohne setState-im-Effect (Muster aus StatementForm).
const subscribeNoop = () => () => {};

function docDraftKey(
  ticketId: string,
  locale: AppLocale | null,
  round: number,
): string {
  return locale
    ? `change-request-${ticketId}-${locale}-${round}`
    : `change-request-${ticketId}-${round}`;
}

function openDraftKey(ticketId: string): string {
  return `change-request-${ticketId}-open`;
}

function toHighlights(findings: ChangeRequestLinterFields): LinterRange[] {
  return (findings.solution ?? []).map((finding) => ({
    start: finding.from,
    end: finding.to,
    reason: finding.reason,
  }));
}

export function ChangeRequestForm({
  ticketId,
  contentLocale,
  currentSolution,
  isLoggedIn,
}: {
  ticketId: string;
  /** Sprache, in der der Antragsteller schreibt (seine Lese-Sprache). */
  contentLocale: AppLocale;
  /** Aktueller Lösungstext in genau dieser Sprache — Vorbefüllung. */
  currentSolution: unknown;
  isLoggedIn: boolean;
}) {
  const t = useTranslations("changeRequests");
  const tRoot = useTranslations();
  const router = useRouter();
  const otherLocales = routing.locales.filter((item) => item !== contentLocale);

  const isClient = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  const [open, setOpen] = useState(
    () => loadDraft(openDraftKey(ticketId)) === true,
  );
  const [step, setStep] = useState<"form" | "preview">("form");
  const [doc, setDoc] = useState<unknown>(null);
  const [translations, setTranslations] = useState<
    Partial<Record<AppLocale, ConstrainedDoc>>
  >({});
  const [findings, setFindings] = useState<ChangeRequestLinterFields>({});
  const [translationFindings, setTranslationFindings] = useState<
    Partial<Record<AppLocale, ChangeRequestLinterFields>>
  >({});
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "prepare" | "submit">(null);
  // Zähler im Draft-Key: nach dem Einreichen startet eine frische Instanz.
  const [round, setRound] = useState(0);

  const currentDoc = (): unknown =>
    doc ?? loadDraft(docDraftKey(ticketId, null, round)) ?? currentSolution;

  const buildDraftInput = () => ({
    locale: contentLocale,
    ticketId,
    solution: currentDoc(),
  });

  const errorText = (code: string): string =>
    t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.invalid_input");

  const handlePrepare = async () => {
    setErrorCode(null);
    const input = buildDraftInput();
    const parsed = changeRequestDraftSchema.safeParse(input);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "invalid_input");
      return;
    }
    setFieldError(null);
    setBusy("prepare");
    try {
      const result = await prepareChangeRequest(input);
      if (!result.ok) {
        if (result.error === "linter") {
          setFindings(result.fields);
        } else {
          setErrorCode(result.error);
        }
        return;
      }
      // Frische Übersetzungen: alte Preview-Entwürfe verwerfen.
      for (const target of otherLocales) {
        clearDraft(docDraftKey(ticketId, target, round));
      }
      setFindings({});
      setTranslations(result.translations);
      setTranslationFindings({});
      setStep("preview");
    } finally {
      setBusy(null);
    }
  };

  const handleSubmit = async () => {
    setErrorCode(null);
    const translationsInput: Record<string, unknown> = {};
    for (const target of otherLocales) {
      const version = translations[target];
      if (version) {
        translationsInput[target] = version;
      }
    }
    setBusy("submit");
    try {
      const result = await submitChangeRequest({
        ...buildDraftInput(),
        translations: translationsInput,
      });
      if (!result.ok) {
        if (result.error === "linter") {
          setTranslationFindings(result.versions);
          const originalFindings = result.versions[contentLocale];
          if (originalFindings) {
            // Beanstandung am Original → zurück in Schritt 1.
            setFindings(originalFindings);
            setStep("form");
          }
        } else {
          setErrorCode(result.error);
        }
        return;
      }
      clearDraft(docDraftKey(ticketId, null, round));
      for (const target of otherLocales) {
        clearDraft(docDraftKey(ticketId, target, round));
      }
      clearDraft(openDraftKey(ticketId));
      setDoc(null);
      setTranslations({});
      setStep("form");
      setOpen(false);
      setRound((value) => value + 1);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!isLoggedIn) {
    return (
      <LoginHint
        message={t("loginHint")}
        linkLabel={t("loginLink")}
        testId="change-request-login-hint"
      />
    );
  }

  if (!isClient) {
    // Entwürfe leben im localStorage — das Formular rendert erst clientseitig.
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="change-request-open"
        onClick={() => {
          saveDraft(openDraftKey(ticketId), true);
          setOpen(true);
        }}
        className="mt-3 self-start rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface"
      >
        {t("newButton")}
      </button>
    );
  }

  const hasFindings = Object.keys(findings).length > 0;
  const hasTranslationFindings = otherLocales.some(
    (target) => Object.keys(translationFindings[target] ?? {}).length > 0,
  );

  const banner = (text: string) => (
    <p
      role="alert"
      className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
    >
      {text}
    </p>
  );

  return (
    <div className="mt-4 flex max-w-[640px] flex-col gap-4">
      {errorCode && banner(errorText(errorCode))}
      {step === "form" && hasFindings && banner(t("linterBlocked"))}
      {step === "preview" &&
        hasTranslationFindings &&
        banner(t("linterBlockedTranslation"))}

      {step === "form" && (
        <>
          <p className="font-mono text-xs text-meta">{t("prefillHint")}</p>
          <div className="flex flex-col gap-1.5">
            <ConstrainedEditor
              key={`original-${round}`}
              name={docDraftKey(ticketId, null, round)}
              label={t("proposedSolution")}
              minChars={SOLUTION_MIN}
              maxChars={SOLUTION_MAX}
              initialContent={currentSolution}
              onUpdate={(next) => {
                setDoc(next);
                setFieldError(null);
                setFindings({});
              }}
              highlights={toHighlights(findings)}
            />
            {fieldError && (
              <p
                data-testid="change-request-field-error"
                className="font-mono text-xs text-signal"
              >
                {errorText(fieldError)}
              </p>
            )}
            {findings.solution && (
              <LinterFeedback findings={findings.solution} />
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                clearDraft(openDraftKey(ticketId));
                setOpen(false);
              }}
              disabled={busy !== null}
              className="rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:border-line disabled:text-meta"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              data-testid="change-request-prepare"
              onClick={() => void handlePrepare()}
              disabled={busy !== null || hasFindings}
              className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
            >
              {busy === "prepare" ? t("checking") : t("toPreview")}
            </button>
          </div>
        </>
      )}

      {step === "preview" && (
        <>
          <p className="text-[15px] leading-relaxed">{t("previewIntro")}</p>
          {otherLocales.map((target) => {
            const version = translations[target];
            if (!version) {
              return null;
            }
            const versionFindings = translationFindings[target] ?? {};
            return (
              <div key={target} className="flex flex-col gap-1.5">
                <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
                  {tRoot(`localeSwitcher.${target}`)}
                </span>
                <ConstrainedEditor
                  key={`${target}-${round}`}
                  name={docDraftKey(ticketId, target, round)}
                  label={`${t("proposedSolution")} — ${tRoot(`localeSwitcher.${target}`)}`}
                  minChars={SOLUTION_MIN}
                  maxChars={SOLUTION_MAX}
                  initialContent={version}
                  onUpdate={(next) => {
                    setTranslations((prev) => ({
                      ...prev,
                      [target]: next as ConstrainedDoc,
                    }));
                    setTranslationFindings((prev) => {
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
              onClick={() => setStep("form")}
              disabled={busy !== null}
              className="rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:border-line disabled:text-meta"
            >
              {t("backToForm")}
            </button>
            <button
              type="button"
              data-testid="change-request-submit"
              onClick={() => void handleSubmit()}
              disabled={busy !== null || hasTranslationFindings}
              className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
            >
              {busy === "submit" ? t("submitting") : t("submit")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
