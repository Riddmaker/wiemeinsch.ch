"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import {
  prepareStatementPublish,
  publishStatement,
  type StatementLinterFields,
} from "@/actions/statements";
import { LoginHint } from "@/components/auth/LoginHint";
import { ConstrainedEditor } from "@/components/editor/ConstrainedEditor";
import { clearDraft, loadDraft, saveDraft } from "@/components/editor/drafts";
import type { LinterRange } from "@/components/editor/linter-highlight";
import { AppealButton } from "@/components/moderation/AppealButton";
import { LinterFeedback } from "@/components/tickets/LinterFeedback";
import { useRouter } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { STATEMENT_MAX, STATEMENT_MIN } from "@/lib/validation/limits";
import {
  statementDraftSchema,
  type StatementCategory,
} from "@/lib/validation/statement";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";

/**
 * Statement-Formular unter dem Ticket (P9.1): dieselbe zweistufige Pipeline
 * wie beim Ticket (P7) — Original erfassen (Civic-Linter inline), dann die
 * Übersetzungs-Preview editieren und transaktional publizieren. Entwürfe
 * leben im localStorage und werden erst nach erfolgreichem Publish gelöscht.
 */

const CATEGORIES: StatementCategory[] = [
  "PRO",
  "CONTRA",
  "ERWEITERUNG",
  "FRAGE",
];

/** Farb-Semantik strikt wie auf der Card (Styleguide Art. 7). */
const CATEGORY_ACTIVE: Record<StatementCategory, string> = {
  PRO: "border-pro bg-pro text-paper",
  CONTRA: "border-contra bg-contra text-paper",
  ERWEITERUNG: "border-ink bg-ink text-paper",
  FRAGE: "border-ink bg-ink text-paper",
};

// Client-Gate ohne setState-im-Effect: Server/Hydration rendern null, danach
// initialisiert der erste Client-Render die States direkt aus dem localStorage.
const subscribeNoop = () => () => {};

function docDraftKey(
  ticketId: string,
  locale: AppLocale | null,
  round: number,
): string {
  return locale
    ? `statement-${ticketId}-${locale}-${round}`
    : `statement-${ticketId}-${round}`;
}

function categoryDraftKey(ticketId: string): string {
  return `statement-${ticketId}-category`;
}

function loadCategory(ticketId: string): StatementCategory {
  const draft = loadDraft(categoryDraftKey(ticketId));
  return CATEGORIES.includes(draft as StatementCategory)
    ? (draft as StatementCategory)
    : "PRO";
}

function toHighlights(findings: StatementLinterFields): LinterRange[] {
  return (findings.content ?? []).map((finding) => ({
    start: finding.from,
    end: finding.to,
    reason: finding.reason,
  }));
}

export function StatementForm({
  ticketId,
  isLoggedIn,
}: {
  ticketId: string;
  isLoggedIn: boolean;
}) {
  const t = useTranslations("statements");
  const tRoot = useTranslations();
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const otherLocales = routing.locales.filter((item) => item !== locale);

  const isClient = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  const [step, setStep] = useState<"form" | "preview">("form");
  const [category, setCategory] = useState<StatementCategory>(() =>
    loadCategory(ticketId),
  );
  const [doc, setDoc] = useState<unknown>(null);
  const [translations, setTranslations] = useState<
    Partial<Record<AppLocale, ConstrainedDoc>>
  >({});
  const [findings, setFindings] = useState<StatementLinterFields>({});
  const [translationFindings, setTranslationFindings] = useState<
    Partial<Record<AppLocale, StatementLinterFields>>
  >({});
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "prepare" | "publish">(null);
  // Zähler im Draft-Key: nach dem Publish rendert eine frische Editor-Instanz
  // (leerer Entwurf) statt des soeben publizierten Texts.
  const [round, setRound] = useState(0);

  const currentDoc = (): unknown =>
    doc ?? loadDraft(docDraftKey(ticketId, null, round)) ?? { type: "doc" };

  const buildDraftInput = () => ({
    locale,
    ticketId,
    category,
    content: currentDoc(),
  });

  const errorText = (code: string): string =>
    t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.invalid_input");

  const handlePrepare = async () => {
    setErrorCode(null);
    const input = buildDraftInput();
    const parsed = statementDraftSchema.safeParse(input);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "invalid_input");
      return;
    }
    setFieldError(null);
    setBusy("prepare");
    try {
      const result = await prepareStatementPublish(input);
      if (!result.ok) {
        if (result.error === "linter") {
          setFindings(result.fields);
        } else {
          setErrorCode(result.error);
        }
        return;
      }
      // Frische Übersetzungen: allfällige alte Preview-Entwürfe verwerfen.
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

  const handlePublish = async () => {
    setErrorCode(null);
    const translationsInput: Record<string, unknown> = {};
    for (const target of otherLocales) {
      const version = translations[target];
      if (version) {
        translationsInput[target] = version;
      }
    }
    setBusy("publish");
    try {
      const result = await publishStatement({
        ...buildDraftInput(),
        translations: translationsInput,
      });
      if (!result.ok) {
        if (result.error === "linter") {
          setTranslationFindings(result.versions);
          const originalFindings = result.versions[locale];
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
      clearDraft(categoryDraftKey(ticketId));
      clearDraft(docDraftKey(ticketId, null, round));
      for (const target of otherLocales) {
        clearDraft(docDraftKey(ticketId, target, round));
      }
      setDoc(null);
      setTranslations({});
      setStep("form");
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
        testId="statement-login-hint"
      />
    );
  }

  if (!isClient) {
    // Entwürfe leben im localStorage — das Formular rendert erst clientseitig
    // (gleiche Strategie wie der Editor mit immediatelyRender: false).
    return null;
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
      {errorCode && banner(t(`errors.${errorCode}`))}
      {step === "form" && hasFindings && (
        <div className="flex flex-col gap-2">
          {banner(t("linterBlocked"))}
          {/* Anfechtung nur für das Original (P12.2) — siehe TicketForm. */}
          <AppealButton kind="statement" buildDraft={buildDraftInput} />
        </div>
      )}
      {step === "preview" &&
        hasTranslationFindings &&
        banner(t("linterBlockedTranslation"))}

      {step === "form" && (
        <>
          <fieldset>
            <legend className="mb-2 font-mono text-[11.5px] uppercase tracking-wide text-ink">
              {t("categoryLabel")}
            </legend>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              {CATEGORIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  data-testid={`statement-category-${value}`}
                  aria-checked={category === value}
                  onClick={() => {
                    setCategory(value);
                    saveDraft(categoryDraftKey(ticketId), value);
                  }}
                  className={`rounded-[2px] border-[1.5px] px-3.5 py-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.07em] ${
                    category === value
                      ? CATEGORY_ACTIVE[value]
                      : "border-ink bg-paper text-ink hover:bg-surface"
                  }`}
                >
                  {t(`categories.${value}`)}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <ConstrainedEditor
              key={`original-${round}`}
              name={docDraftKey(ticketId, null, round)}
              label={t("formHeading")}
              minChars={STATEMENT_MIN}
              maxChars={STATEMENT_MAX}
              onUpdate={(next) => {
                setDoc(next);
                setFieldError(null);
                setFindings({});
              }}
              highlights={toHighlights(findings)}
            />
            {fieldError && (
              <p
                data-testid="statement-field-error"
                className="font-mono text-xs text-signal"
              >
                {errorText(fieldError)}
              </p>
            )}
            {findings.content && <LinterFeedback findings={findings.content} />}
          </div>

          <button
            type="button"
            data-testid="statement-prepare"
            onClick={() => void handlePrepare()}
            disabled={busy !== null || hasFindings}
            className="self-start rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
          >
            {busy === "prepare" ? t("checking") : t("toPreview")}
          </button>
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
                  label={`${t("formHeading")} — ${tRoot(`localeSwitcher.${target}`)}`}
                  minChars={STATEMENT_MIN}
                  maxChars={STATEMENT_MAX}
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
                {versionFindings.content && (
                  <LinterFeedback findings={versionFindings.content} />
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
              data-testid="statement-publish"
              onClick={() => void handlePublish()}
              disabled={busy !== null || hasTranslationFindings}
              className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
            >
              {busy === "publish" ? t("publishing") : t("publish")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
