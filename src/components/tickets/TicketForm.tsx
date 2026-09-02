"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  prepareTicketPublish,
  publishTicket,
  type TicketField,
  type TicketLinterFields,
  type TicketTranslationPreview,
} from "@/actions/tickets";
import { ConstrainedEditor } from "@/components/editor/ConstrainedEditor";
import { clearDraft, loadDraft, saveDraft } from "@/components/editor/drafts";
import type { LinterRange } from "@/components/editor/linter-highlight";
import { HashtagInput } from "@/components/tickets/HashtagInput";
import { AppealButton } from "@/components/moderation/AppealButton";
import { LinterFeedback } from "@/components/tickets/LinterFeedback";
import {
  SearchSelect,
  type SearchOption,
} from "@/components/tickets/SearchSelect";
import { routing, type AppLocale } from "@/i18n/routing";
import { Link, useRouter } from "@/i18n/navigation";
import {
  FUNDING_MAX,
  PROBLEM_MAX,
  PROBLEM_MIN,
  SOLUTION_MAX,
  SOLUTION_MIN,
  TITLE_MAX,
} from "@/lib/validation/limits";
import { ticketDraftSchema } from "@/lib/validation/ticket";
import { graphemeLength } from "@/lib/validation/tiptap";
import type { z } from "zod";

/**
 * Ticket-Publish-Flow (P7): EIN Formular-Flow mit zwei Schritten —
 * 1. Original erfassen (Linter-Feedback inline), 2. Übersetzungs-Preview
 * editieren, dann transaktional publizieren. Entwürfe leben im localStorage
 * und werden erst nach erfolgreichem Publish gelöscht (P7.7).
 */

type Level = "FEDERAL" | "CANTONAL" | "MUNICIPAL";
type DocField = "problem" | "solution" | "funding";
type Step = "form" | "preview";

const META_DRAFT_KEY = "ticket-new-meta";
const DOC_FIELDS: DocField[] = ["problem", "solution", "funding"];
const EMPTY_DOC = { type: "doc", content: [] };

function docDraftKey(locale: AppLocale | null, field: DocField): string {
  return locale ? `ticket-new-${locale}-${field}` : `ticket-new-${field}`;
}

type MetaDraft = {
  level: Level;
  cantonId: number | null;
  municipalityId: number | null;
  title: string;
  hashtags: string[];
};

/** Meta-Entwurf (Ebene/Titel/Hashtags) defensiv aus dem localStorage lesen. */
function loadMetaDraft(): MetaDraft {
  const fallback: MetaDraft = {
    level: "FEDERAL",
    cantonId: null,
    municipalityId: null,
    title: "",
    hashtags: [],
  };
  const draft = loadDraft(META_DRAFT_KEY);
  if (!draft || typeof draft !== "object") {
    return fallback;
  }
  const meta = draft as Partial<MetaDraft>;
  return {
    level:
      meta.level === "CANTONAL" || meta.level === "MUNICIPAL"
        ? meta.level
        : "FEDERAL",
    cantonId: typeof meta.cantonId === "number" ? meta.cantonId : null,
    municipalityId:
      typeof meta.municipalityId === "number" ? meta.municipalityId : null,
    title: typeof meta.title === "string" ? meta.title : "",
    hashtags:
      Array.isArray(meta.hashtags) &&
      meta.hashtags.every((tag) => typeof tag === "string")
        ? meta.hashtags
        : [],
  };
}

// Client-Gate ohne setState-im-Effect: Server/Hydration rendern null, danach
// initialisiert der erste Client-Render die States direkt aus dem localStorage.
const subscribeNoop = () => () => {};

function toHighlights(findings: TicketLinterFields, field: TicketField) {
  return (findings[field] ?? []).map((finding): LinterRange => ({
    start: finding.from,
    end: finding.to,
    reason: finding.reason,
  }));
}

type Suggestion = {
  id: string;
  title: string;
  upvotes: number;
  downvotes: number;
};

export function TicketForm({
  cantons,
  municipalities,
}: {
  cantons: SearchOption[];
  municipalities: SearchOption[];
}) {
  const t = useTranslations("ticketNew");
  const tRoot = useTranslations();
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const chNumber = new Intl.NumberFormat(`${locale}-CH`);
  const otherLocales = routing.locales.filter((item) => item !== locale);

  const isClient = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  const [step, setStep] = useState<Step>("form");
  const [level, setLevel] = useState<Level>(() => loadMetaDraft().level);
  const [cantonId, setCantonId] = useState<number | null>(
    () => loadMetaDraft().cantonId,
  );
  const [municipalityId, setMunicipalityId] = useState<number | null>(
    () => loadMetaDraft().municipalityId,
  );
  const [title, setTitle] = useState(() => loadMetaDraft().title);
  const [hashtags, setHashtags] = useState<string[]>(
    () => loadMetaDraft().hashtags,
  );
  const [docs, setDocs] = useState<Record<DocField, unknown>>({
    problem: null,
    solution: null,
    funding: null,
  });
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<TicketField | "level", string>>
  >({});
  const [findings, setFindings] = useState<TicketLinterFields>({});
  const [translations, setTranslations] = useState<
    Partial<Record<AppLocale, TicketTranslationPreview>>
  >({});
  const [translationFindings, setTranslationFindings] = useState<
    Partial<Record<AppLocale, TicketLinterFields>>
  >({});
  const [busy, setBusy] = useState<null | "prepare" | "publish">(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // Snapshot des zuletzt erfolgreich vorbereiteten Originals: unverändert
  // zurück-und-vor kostet keinen neuen Linter-/Übersetzungslauf und erhält
  // die editierten Übersetzungen.
  const preparedSnapshot = useRef<string | null>(null);

  // Meta-Entwurf fortschreiben (Auto-Save wie im Editor, P7.7).
  useEffect(() => {
    saveDraft(META_DRAFT_KEY, {
      level,
      cantonId,
      municipalityId,
      title,
      hashtags,
    });
  }, [level, cantonId, municipalityId, title, hashtags]);

  // Duplikat-Check (P7.2): debounced nach Titel-Eingabe.
  useEffect(() => {
    const q = title.trim();
    const inactive = step !== "form" || q.length < 3;
    const timer = setTimeout(
      () => {
        if (inactive) {
          setSuggestions([]);
          return;
        }
        fetch(
          `/api/tickets/similar?q=${encodeURIComponent(q)}&locale=${locale}`,
        )
          .then((res) => (res.ok ? res.json() : { suggestions: [] }))
          .then((data: { suggestions?: Suggestion[] }) =>
            setSuggestions(data.suggestions ?? []),
          )
          .catch(() => {
            // Duplikat-Vorschläge sind Komfort — Fehler nie anzeigen.
          });
      },
      inactive ? 0 : 500,
    );
    return () => clearTimeout(timer);
  }, [title, step, locale]);

  const resolveDoc = (field: DocField): unknown =>
    docs[field] ?? loadDraft(docDraftKey(null, field)) ?? EMPTY_DOC;

  const clearFinding = (field: TicketField) => {
    setFindings((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const updateDoc = (field: DocField) => (doc: unknown) => {
    setDocs((prev) => ({ ...prev, [field]: doc }));
    clearFinding(field);
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const buildDraftInput = () => ({
    locale,
    level,
    cantonId: level === "CANTONAL" ? cantonId : null,
    municipalityId: level === "MUNICIPAL" ? municipalityId : null,
    title: title.trim(),
    hashtags,
    problem: resolveDoc("problem"),
    solution: resolveDoc("solution"),
    funding: resolveDoc("funding"),
  });

  const mapIssues = (error: z.ZodError) => {
    const next: Partial<Record<TicketField | "level", string>> = {};
    for (const issue of error.issues) {
      const head = issue.path[0];
      if (
        head === "title" ||
        head === "hashtags" ||
        head === "problem" ||
        head === "solution" ||
        head === "funding"
      ) {
        next[head] ??= issue.message;
      } else {
        next.level ??= issue.message;
      }
    }
    return next;
  };

  // Unbekannte Zod-Codes (Default-Messages) fallen auf die generische Meldung zurück.
  const errorText = (code: string | undefined): string | undefined =>
    code
      ? t.has(`errors.${code}`)
        ? t(`errors.${code}`)
        : t("errors.invalid_input")
      : undefined;

  const handlePrepare = async () => {
    setErrorCode(null);
    const input = buildDraftInput();
    const parsed = ticketDraftSchema.safeParse(input);
    if (!parsed.success) {
      setFieldErrors(mapIssues(parsed.error));
      return;
    }
    setFieldErrors({});
    const snapshot = JSON.stringify(input);
    if (
      snapshot === preparedSnapshot.current &&
      Object.keys(translations).length > 0
    ) {
      setStep("preview");
      window.scrollTo({ top: 0 });
      return;
    }
    setBusy("prepare");
    try {
      const result = await prepareTicketPublish(input);
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
        for (const field of DOC_FIELDS) {
          clearDraft(docDraftKey(target, field));
        }
      }
      setTranslations(result.translations);
      setTranslationFindings({});
      preparedSnapshot.current = snapshot;
      setStep("preview");
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(null);
    }
  };

  const handlePublish = async () => {
    setErrorCode(null);
    const translationsInput: Record<string, unknown> = {};
    for (const target of otherLocales) {
      const version = translations[target];
      if (!version) continue;
      translationsInput[target] = {
        title: version.title.trim(),
        problem: version.problem,
        solution: version.solution,
        ...(version.funding ? { funding: version.funding } : {}),
      };
    }
    setBusy("publish");
    try {
      const result = await publishTicket({
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
            window.scrollTo({ top: 0 });
          }
        } else {
          setErrorCode(result.error);
        }
        return;
      }
      clearDraft(META_DRAFT_KEY);
      for (const field of DOC_FIELDS) {
        clearDraft(docDraftKey(null, field));
        for (const target of otherLocales) {
          clearDraft(docDraftKey(target, field));
        }
      }
      router.push(`/tickets/${result.ticketId}`);
    } finally {
      setBusy(null);
    }
  };

  const updateTranslation = (
    target: AppLocale,
    patch: Partial<TicketTranslationPreview>,
    editedField: TicketField,
  ) => {
    setTranslations((prev) => {
      const current = prev[target];
      if (!current) return prev;
      return { ...prev, [target]: { ...current, ...patch } };
    });
    setTranslationFindings((prev) => {
      const current = prev[target];
      if (!current?.[editedField]) return prev;
      const nextFields = { ...current };
      delete nextFields[editedField];
      return { ...prev, [target]: nextFields };
    });
  };

  const hasFindings = Object.keys(findings).length > 0;
  const hasTranslationFindings = otherLocales.some(
    (target) => Object.keys(translationFindings[target] ?? {}).length > 0,
  );
  const titleLength = graphemeLength(title.trim());

  const banner = (text: string, tone: "error" | "info") => (
    <p
      role="alert"
      className={`border px-4 py-3 font-mono text-xs ${
        tone === "error"
          ? "border-signal bg-signal-bg text-signal"
          : "border-line bg-surface text-meta"
      }`}
    >
      {text}
    </p>
  );

  if (!isClient) {
    // Entwürfe leben im localStorage — das Formular rendert erst clientseitig
    // (gleiche Strategie wie der Editor mit immediatelyRender: false).
    return null;
  }

  return (
    <div className="flex flex-col gap-8">
      {errorCode && banner(t(`errors.${errorCode}`), "error")}
      {step === "form" && hasFindings && (
        <div className="flex flex-col gap-2">
          {banner(t("linterBlocked"), "error")}
          {/* Anfechtung nur für das Original (P12.2): eine blockierte
              Übersetzung korrigiert man im Editor, dafür braucht es keinen
              Moderationsfall. */}
          <AppealButton kind="ticket" buildDraft={buildDraftInput} />
        </div>
      )}
      {step === "preview" &&
        hasTranslationFindings &&
        banner(t("linterBlockedTranslation"), "error")}

      {step === "form" && (
        <>
          {/* Politische Ebene — zwingend zuoberst (REQUIREMENTS-Hierarchie) */}
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1.5 font-mono text-[11.5px] uppercase tracking-wide text-ink">
              {t("levelLabel")}
            </legend>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              {(
                [
                  ["FEDERAL", tRoot("levels.FEDERAL")],
                  ["CANTONAL", tRoot("levels.CANTONAL")],
                  ["MUNICIPAL", tRoot("levels.MUNICIPAL")],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={level === value}
                  onClick={() => {
                    setLevel(value);
                    setCantonId(null);
                    setMunicipalityId(null);
                    setFieldErrors((prev) => ({ ...prev, level: undefined }));
                  }}
                  className={`rounded-[2px] border-[1.5px] px-4 py-2 text-[14.5px] font-semibold ${
                    level === value
                      ? "border-ink bg-ink text-paper"
                      : "border-ink bg-paper text-ink hover:bg-surface"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {level === "CANTONAL" && (
              <SearchSelect
                label={t("cantonLabel")}
                options={cantons}
                value={cantonId}
                onSelect={(id) => {
                  setCantonId(id);
                  setFieldErrors((prev) => ({ ...prev, level: undefined }));
                }}
                noResultsText={t("noResults")}
                error={errorText(fieldErrors.level)}
              />
            )}
            {level === "MUNICIPAL" && (
              <SearchSelect
                label={t("municipalityLabel")}
                options={municipalities}
                value={municipalityId}
                onSelect={(id) => {
                  setMunicipalityId(id);
                  setFieldErrors((prev) => ({ ...prev, level: undefined }));
                }}
                noResultsText={t("noResults")}
                error={errorText(fieldErrors.level)}
              />
            )}
            {level === "FEDERAL" && fieldErrors.level && (
              <p className="font-mono text-xs text-signal">
                {errorText(fieldErrors.level)}
              </p>
            )}
          </fieldset>

          {/* Titel */}
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
                {t("titleLabel")}
              </span>
              <input
                type="text"
                name="title"
                value={title}
                autoComplete="off"
                onChange={(event) => {
                  setTitle(event.target.value);
                  clearFinding("title");
                  setFieldErrors((prev) => ({ ...prev, title: undefined }));
                }}
                className={`rounded-[2px] border-[1.5px] px-3 py-2.5 text-[15px] ${
                  fieldErrors.title || findings.title
                    ? "border-signal bg-signal-bg"
                    : "border-ink bg-paper"
                }`}
              />
            </label>
            <span
              className={`text-right font-mono text-[11.5px] ${
                titleLength > TITLE_MAX ? "text-signal" : "text-meta"
              }`}
            >
              {t("counter", {
                count: chNumber.format(titleLength),
                max: chNumber.format(TITLE_MAX),
              })}
            </span>
            {fieldErrors.title && (
              <p className="font-mono text-xs text-signal">
                {errorText(fieldErrors.title)}
              </p>
            )}
            {findings.title && <LinterFeedback findings={findings.title} />}
            {suggestions.length > 0 && (
              <div
                className="border border-line bg-surface px-4 py-3"
                data-testid="duplicate-suggestions"
              >
                <p className="mb-2 font-mono text-xs font-bold uppercase tracking-wide text-meta">
                  {t("duplicateHint")}
                </p>
                <ul className="flex flex-col gap-2">
                  {suggestions.map((suggestion) => (
                    <li
                      key={suggestion.id}
                      className="flex flex-wrap items-baseline gap-3"
                    >
                      <Link
                        href={`/tickets/${suggestion.id}`}
                        target="_blank"
                        rel="noopener"
                        className="font-serif text-[15px] font-bold underline-offset-2 hover:underline"
                      >
                        {suggestion.title}
                      </Link>
                      <span className="font-mono text-xs">
                        <span className="font-bold text-pro">
                          ▲ {chNumber.format(suggestion.upvotes)}
                        </span>{" "}
                        <span className="font-bold text-meta">
                          ▼ {chNumber.format(suggestion.downvotes)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Hashtags — direkt unter dem Titel (REQUIREMENTS-Hierarchie) */}
          <div className="flex flex-col gap-1.5">
            <HashtagInput
              tags={hashtags}
              onChange={(next) => {
                setHashtags(next);
                clearFinding("hashtags");
                setFieldErrors((prev) => ({ ...prev, hashtags: undefined }));
              }}
              error={errorText(fieldErrors.hashtags)}
            />
            {findings.hashtags && (
              <LinterFeedback findings={findings.hashtags} />
            )}
          </div>

          {/* Problem / Lösung / Finanzierung */}
          {(
            [
              ["problem", t("problemLabel"), PROBLEM_MIN, PROBLEM_MAX],
              ["solution", t("solutionLabel"), SOLUTION_MIN, SOLUTION_MAX],
              ["funding", t("fundingLabel"), 0, FUNDING_MAX],
            ] as const
          ).map(([field, label, min, max]) => (
            <div key={field} className="flex flex-col gap-1.5">
              <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
                {label}
              </span>
              <ConstrainedEditor
                name={docDraftKey(null, field)}
                label={label}
                minChars={min}
                maxChars={max}
                onUpdate={updateDoc(field)}
                highlights={toHighlights(findings, field)}
              />
              {fieldErrors[field] && (
                <p className="font-mono text-xs text-signal">
                  {errorText(fieldErrors[field])}
                </p>
              )}
              {findings[field] && <LinterFeedback findings={findings[field]} />}
            </div>
          ))}

          <button
            type="button"
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
          <p className="max-w-prose text-[15px] leading-relaxed">
            {t("previewIntro")}
          </p>
          {otherLocales.map((target) => {
            const version = translations[target];
            if (!version) return null;
            const versionFindings = translationFindings[target] ?? {};
            return (
              <section key={target} className="flex flex-col gap-4">
                <h2 className="border-b-2 border-ink pb-2 font-mono text-sm font-bold uppercase tracking-wide">
                  {tRoot(`localeSwitcher.${target}`)}
                </h2>
                <div className="flex flex-col gap-1.5">
                  <label className="flex flex-col gap-1.5">
                    <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
                      {t("titleLabel")}
                    </span>
                    <input
                      type="text"
                      value={version.title}
                      autoComplete="off"
                      onChange={(event) =>
                        updateTranslation(
                          target,
                          { title: event.target.value },
                          "title",
                        )
                      }
                      className={`rounded-[2px] border-[1.5px] px-3 py-2.5 text-[15px] ${
                        versionFindings.title
                          ? "border-signal bg-signal-bg"
                          : "border-ink bg-paper"
                      }`}
                    />
                  </label>
                  <span
                    className={`text-right font-mono text-[11.5px] ${
                      graphemeLength(version.title.trim()) > TITLE_MAX
                        ? "text-signal"
                        : "text-meta"
                    }`}
                  >
                    {t("counter", {
                      count: chNumber.format(
                        graphemeLength(version.title.trim()),
                      ),
                      max: chNumber.format(TITLE_MAX),
                    })}
                  </span>
                  {versionFindings.title && (
                    <LinterFeedback findings={versionFindings.title} />
                  )}
                </div>
                {(
                  [
                    ["problem", t("problemLabel"), PROBLEM_MIN, PROBLEM_MAX],
                    [
                      "solution",
                      t("solutionLabel"),
                      SOLUTION_MIN,
                      SOLUTION_MAX,
                    ],
                    ["funding", t("fundingLabel"), 0, FUNDING_MAX],
                  ] as const
                ).map(([field, label, min, max]) => {
                  const doc = version[field];
                  if (field === "funding" && !doc) return null;
                  return (
                    <div key={field} className="flex flex-col gap-1.5">
                      <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
                        {label}
                      </span>
                      <ConstrainedEditor
                        name={docDraftKey(target, field)}
                        label={`${label} — ${tRoot(`localeSwitcher.${target}`)}`}
                        minChars={min}
                        maxChars={max}
                        initialContent={doc}
                        onUpdate={(nextDoc) =>
                          updateTranslation(
                            target,
                            {
                              [field]: nextDoc,
                            } as Partial<TicketTranslationPreview>,
                            field,
                          )
                        }
                        highlights={toHighlights(versionFindings, field)}
                      />
                      {versionFindings[field] && (
                        <LinterFeedback findings={versionFindings[field]} />
                      )}
                    </div>
                  );
                })}
              </section>
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
