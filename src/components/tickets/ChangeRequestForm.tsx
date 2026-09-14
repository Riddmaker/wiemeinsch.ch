"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  prepareChangeRequest,
  submitChangeRequest,
  type ChangeRequestLinterFields,
} from "@/actions/change-requests";
import { callAction } from "@/lib/call-action";
import { LoginHint } from "@/components/auth/LoginHint";
import { ConstrainedEditor } from "@/components/editor/ConstrainedEditor";
import { clearDraft, loadDraft, saveDraft } from "@/components/editor/drafts";
import { HashtagInput } from "@/components/tickets/HashtagInput";
import { LinterFeedback } from "@/components/tickets/LinterFeedback";
import {
  DOC_FIELD_LIMITS,
  ProposalFields,
  toHighlights,
} from "@/components/tickets/ProposalFields";
import { useRouter } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import {
  CHANGE_REQUEST_TEXT_FIELDS,
  changeRequestDraftSchema,
  type ChangeRequestProposal,
  type ChangeRequestTextField,
} from "@/lib/validation/change-request";
import { TITLE_MAX } from "@/lib/validation/limits";
import { plainText, type ConstrainedDoc } from "@/lib/validation/tiptap";

/**
 * Änderungsantrag stellen (P10.1): Die Felder starten mit dem aktuellen
 * Ticket-Inhalt in der Lese-Sprache des Antragstellers; danach läuft exakt
 * die Pipeline von Ticket (P7) und Statement (P9) — Civic-Linter inline,
 * Übersetzungs-Preview in den zwei anderen Landessprachen, dann einreichen.
 *
 * E12 (04.09.2026): Alle Inhaltsfelder sind änderbar. Der Antragsteller muss
 * NICHT ankreuzen, was er ändern will — beim Prüfen wird gegen den aktuellen
 * Stand verglichen und nur Abweichendes eingereicht. Das hält das Formular
 * frei von Verwaltungsarbeit und verhindert Anträge, die ein Feld
 * «ändern», ohne es zu ändern.
 *
 * E15 (14.09.2026): Mit `revision` überarbeitet der Antragsteller seinen
 * eigenen laufenden Antrag. Die Felder starten dann mit seinem Vorschlag
 * (nicht angefasste Felder mit dem Ticket-Stand), verglichen wird weiterhin
 * gegen das Ticket, und die Actions ersetzen den bestehenden Antrag.
 */

// Client-Gate ohne setState-im-Effect (Muster aus StatementForm).
const subscribeNoop = () => () => {};

/** Rich-Text-Felder in Formular-Reihenfolge; der Titel läuft separat. */
const DOC_FIELDS = ["problem", "solution", "funding"] as const;

export type CurrentVersion = {
  title: string;
  problem: unknown;
  solution: unknown;
  funding: unknown;
  hashtags: string[];
};

/**
 * Entwurfs-Präfix: ein neuer Antrag hängt am Ticket, eine Überarbeitung am
 * Antrag — sonst überschrieben sich die beiden Entwürfe gegenseitig.
 */
function draftKey(
  base: string,
  field: string,
  locale: AppLocale | null,
  round: number,
): string {
  return locale
    ? `${base}-${field}-${locale}-${round}`
    : `${base}-${field}-${round}`;
}

function openDraftKey(base: string): string {
  return `${base}-open`;
}

/** Inhaltsgleichheit zweier Dokumente — gleiche Herkunft, gleiche Struktur. */
function sameDoc(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function isEmptyDoc(doc: unknown): boolean {
  if (!doc) {
    return true;
  }
  try {
    return plainText(doc as ConstrainedDoc).trim().length === 0;
  } catch {
    return true;
  }
}

export function ChangeRequestForm({
  ticketId,
  contentLocale,
  current,
  isLoggedIn,
  revision,
  secondaryAction,
}: {
  ticketId: string;
  /** Sprache, in der der Antragsteller schreibt (seine Lese-Sprache). */
  contentLocale: AppLocale;
  /** Aktueller Ticket-Inhalt in genau dieser Sprache — Vorbefüllung. */
  current: CurrentVersion;
  isLoggedIn: boolean;
  /** E15: eigenen laufenden Antrag überarbeiten statt einen neuen stellen. */
  revision?: {
    changeRequestId: string;
    /** Vorschlag in der Sprache des Antragstellers. */
    proposal: ChangeRequestProposal;
    hashtags?: string[];
  };
  /** Weiterer Knopf neben dem Öffnen-Knopf (E15: «Zurückziehen»). */
  secondaryAction?: ReactNode;
}) {
  const t = useTranslations("changeRequests");
  const tTicket = useTranslations("ticketDetail");
  const tNew = useTranslations("ticketNew");
  const tRoot = useTranslations();
  const router = useRouter();
  const otherLocales = routing.locales.filter((item) => item !== contentLocale);

  const isClient = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  const draftBase = revision
    ? `change-request-rev-${revision.changeRequestId}`
    : `change-request-${ticketId}`;
  // Startwerte: bei einer Überarbeitung der eigene Vorschlag, sonst das Ticket.
  const initialTitle = revision?.proposal.title ?? current.title;
  const initialHashtags = revision?.hashtags ?? current.hashtags;
  const initialDoc = (field: (typeof DOC_FIELDS)[number]): unknown =>
    revision?.proposal[field] ?? current[field];

  const [open, setOpen] = useState(
    () => loadDraft(openDraftKey(draftBase)) === true,
  );
  const [step, setStep] = useState<"form" | "preview">("form");
  const [title, setTitle] = useState(initialTitle);
  const [docs, setDocs] = useState<Record<string, unknown>>({});
  const [hashtags, setHashtags] = useState<string[]>(initialHashtags);
  const [translations, setTranslations] = useState<
    Partial<Record<AppLocale, ChangeRequestProposal>>
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

  const fieldLabel: Record<ChangeRequestTextField, string> = {
    title: tNew("titleLabel"),
    problem: tTicket("problem"),
    solution: tTicket("solution"),
    funding: tTicket("funding"),
  };

  const docValue = (field: "problem" | "solution" | "funding"): unknown =>
    docs[field] ??
    loadDraft(draftKey(draftBase, field, null, round)) ??
    initialDoc(field);

  /** Nur das einreichen, was sich vom aktuellen Stand unterscheidet. */
  const buildProposal = (): ChangeRequestProposal => {
    const proposal: ChangeRequestProposal = {};
    if (title.trim() !== current.title) {
      proposal.title = title.trim();
    }
    for (const field of DOC_FIELDS) {
      const value = docValue(field);
      const currentValue = current[field];
      // Ein leer gelassenes Finanzierungsfeld, das schon vorher leer war,
      // ist keine Änderung.
      if (
        field === "funding" &&
        isEmptyDoc(value) &&
        isEmptyDoc(currentValue)
      ) {
        continue;
      }
      if (!sameDoc(value, currentValue)) {
        proposal[field] = value as ConstrainedDoc;
      }
    }
    return proposal;
  };

  const hashtagsChanged = (): boolean =>
    [...hashtags].sort().join("\u0000") !==
    [...current.hashtags].sort().join("\u0000");

  const buildDraftInput = () => {
    const proposal = buildProposal();
    return {
      locale: contentLocale,
      ticketId,
      ...(revision ? { changeRequestId: revision.changeRequestId } : {}),
      ...proposal,
      ...(hashtagsChanged() ? { hashtags } : {}),
    };
  };

  const errorText = (code: string): string =>
    t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.invalid_input");

  const changedTextFields = (): ChangeRequestTextField[] => {
    const proposal = buildProposal();
    return CHANGE_REQUEST_TEXT_FIELDS.filter(
      (field) => proposal[field] !== undefined,
    );
  };

  const handlePrepare = async () => {
    setErrorCode(null);
    const input = buildDraftInput();
    const parsed = changeRequestDraftSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? "invalid_input";
      setFieldError(issue === "no_fields" ? "no_changes" : issue);
      return;
    }
    setFieldError(null);
    setBusy("prepare");
    try {
      const result = await callAction(() => prepareChangeRequest(input));
      if (!result) return;
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
        for (const field of CHANGE_REQUEST_TEXT_FIELDS) {
          clearDraft(draftKey(draftBase, field, target, round));
        }
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
      const result = await callAction(() =>
        submitChangeRequest({
          ...buildDraftInput(),
          translations: translationsInput,
        }),
      );
      if (!result) return;
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
      for (const field of CHANGE_REQUEST_TEXT_FIELDS) {
        clearDraft(draftKey(draftBase, field, null, round));
        for (const target of otherLocales) {
          clearDraft(draftKey(draftBase, field, target, round));
        }
      }
      clearDraft(openDraftKey(draftBase));
      setDocs({});
      setTitle(initialTitle);
      setHashtags(initialHashtags);
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
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid={revision ? "change-request-edit" : "change-request-open"}
          onClick={() => {
            saveDraft(openDraftKey(draftBase), true);
            setOpen(true);
          }}
          className="rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface"
        >
          {revision ? t("editButton") : t("newButton")}
        </button>
        {secondaryAction}
      </div>
    );
  }

  const hasFindings = Object.keys(findings).length > 0;
  const hasTranslationFindings = otherLocales.some(
    (target) => Object.keys(translationFindings[target] ?? {}).length > 0,
  );
  const previewFields = changedTextFields();

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
          <p className="font-mono text-xs text-meta">
            {revision ? t("revisionHint") : t("prefillHint")}
          </p>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
              {fieldLabel.title}
            </span>
            <input
              type="text"
              data-testid="change-request-title"
              maxLength={TITLE_MAX}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setFieldError(null);
                setFindings({});
              }}
              className="rounded-[2px] border-[1.5px] border-line bg-paper px-3 py-2 font-serif text-[15.5px] focus:border-ink focus:outline-none"
            />
            {findings.title && <LinterFeedback findings={findings.title} />}
          </label>

          {DOC_FIELDS.map((field) => (
            <div key={field} className="flex flex-col gap-1.5">
              <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
                {fieldLabel[field]}
              </span>
              <ConstrainedEditor
                key={`${field}-${round}`}
                name={draftKey(draftBase, field, null, round)}
                label={fieldLabel[field]}
                minChars={DOC_FIELD_LIMITS[field].min}
                maxChars={DOC_FIELD_LIMITS[field].max}
                initialContent={initialDoc(field)}
                onUpdate={(next) => {
                  setDocs((prev) => ({ ...prev, [field]: next }));
                  setFieldError(null);
                  setFindings({});
                }}
                highlights={toHighlights(findings, field)}
              />
              {findings[field] && <LinterFeedback findings={findings[field]} />}
            </div>
          ))}

          <div className="flex flex-col gap-1.5">
            {/* Beschriftung rendert HashtagInput selbst — ohne «(optional)»,
                weil im Änderungsantrag ohnehin jedes Feld freiwillig ist. */}
            <HashtagInput
              tags={hashtags}
              onChange={setHashtags}
              label={t("hashtagsField")}
            />
            {findings.hashtags && (
              <LinterFeedback findings={findings.hashtags} />
            )}
          </div>

          {fieldError && (
            <p
              data-testid="change-request-field-error"
              className="font-mono text-xs text-signal"
            >
              {errorText(fieldError)}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                clearDraft(openDraftKey(draftBase));
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
              <div key={target} className="flex flex-col gap-3">
                <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
                  {tRoot(`localeSwitcher.${target}`)}
                </span>

                <ProposalFields
                  fields={previewFields}
                  version={version}
                  onFieldChange={(field, value) => {
                    setTranslations((prev) => ({
                      ...prev,
                      [target]: { ...prev[target], [field]: value },
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
                  findings={versionFindings}
                  draftKey={(field) =>
                    draftKey(draftBase, field, target, round)
                  }
                  editorKey={`${target}-${round}`}
                  testIdPrefix={`change-request-${target}`}
                  labelSuffix={tRoot(`localeSwitcher.${target}`)}
                />
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
