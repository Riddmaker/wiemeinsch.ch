"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import {
  declineChangeRequest,
  mergeAdjustedChangeRequest,
  mergeChangeRequest,
  prepareAdjustedMerge,
  returnChangeRequest,
  type ChangeRequestLinterFields,
} from "@/actions/change-requests";
import { callAction } from "@/lib/call-action";
import { clearDraft, loadDraft } from "@/components/editor/drafts";
import { HashtagInput } from "@/components/tickets/HashtagInput";
import { LinterFeedback } from "@/components/tickets/LinterFeedback";
import { ProposalFields } from "@/components/tickets/ProposalFields";
import { useRouter } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import {
  CHANGE_REQUEST_RETURN_REASONS,
  CHANGE_REQUEST_TEXT_FIELDS,
  changeRequestProposalSchema,
  type ChangeRequestProposal,
  type ChangeRequestReturnReason,
  type ChangeRequestTextField,
} from "@/lib/validation/change-request";
import {
  hasTranslationIssues,
  translationIssues,
} from "@/lib/validation/translation-check";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";

/**
 * Entscheid über einen Änderungsantrag (P10.3) — nur für den Ticket-Autor
 * gerendert; die Berechtigung prüft zusätzlich jede Server Action.
 *
 * E15 (14.09.2026), vier Wege, jeder mit genau einer Wirkung:
 * - **Übernehmen** — unverändert 1:1. Der Server nimmt die gespeicherten
 *   Fassungen; nichts wird neu übersetzt, nichts neu gelintet.
 * - **Anpassen & übernehmen** — der Autor bearbeitet in SEINER Sprache, die
 *   zwei anderen werden neu übersetzt (Preview wie beim Ticket-Erstellen).
 *   Die Karte vermerkt danach «mit Anpassungen».
 * - **Zur Überarbeitung** — zurück an den Antragsteller, mit einem Grund aus
 *   dem festen Katalog.
 * - **Ablehnen** — wie bisher.
 */

const subscribeNoop = () => () => {};

type Mode = "idle" | "confirm" | "return" | "adjust" | "adjustPreview";

type Busy = null | "merge" | "prepare" | "return" | "decline";

const BUTTON_PRIMARY =
  "rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta";
const BUTTON_SECONDARY =
  "rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:border-line disabled:text-meta";

function adjustDraftKey(
  changeRequestId: string,
  field: string,
  locale: AppLocale,
  round: number,
): string {
  return `change-request-adjust-${changeRequestId}-${field}-${locale}-${round}`;
}

export function ChangeRequestDecision({
  changeRequestId,
  status,
  requesterHandle,
  contentLocale,
  proposedVersions,
  changedFields,
  proposedHashtags,
  isStale,
  revisedAt,
}: {
  changeRequestId: string;
  /** Nur laufende Anträge haben einen Entscheid (E15). */
  status: "OPEN" | "CHANGES_REQUESTED";
  requesterHandle: string | null;
  /** Sprache des Ticket-Autors — in ihr passt er an. */
  contentLocale: AppLocale;
  /** Die drei gespeicherten Fassungen des Antrags. */
  proposedVersions: Partial<Record<AppLocale, ChangeRequestProposal>>;
  /** Welche Textfelder der Antrag betrifft (E12) — nur diese sind anpassbar. */
  changedFields: ChangeRequestTextField[];
  /** Vorgeschlagene Hashtags, falls der Antrag sie ändert. */
  proposedHashtags?: string[];
  /** true, wenn der Ticket-Inhalt seit Antragstellung geändert wurde (P10.4). */
  isStale: boolean;
  /**
   * Revisionsstand der angezeigten Fassung (ISO, `null` = nie überarbeitet).
   * Jeder Entscheid über den Inhalt schickt ihn mit; hat der Antragsteller
   * inzwischen überarbeitet, lehnt der Server mit `revised` ab.
   */
  revisedAt: string | null;
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

  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState<Busy>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [reason, setReason] = useState<ChangeRequestReturnReason | null>(null);
  // Zähler im Draft-Key: eine neue Übersetzung startet frische Preview-Editoren.
  const [round, setRound] = useState(0);

  const ownKey = (field: ChangeRequestTextField) =>
    adjustDraftKey(changeRequestId, field, contentLocale, 0);

  // Nur die in DIESER Sitzung geänderten Felder. Gelesen wird mit Fallback
  // Entwurf → gespeicherter Vorschlag: Nach einem Neuladen zeigt der Editor
  // den Entwurf aus dem localStorage, und genau der muss auch abgeschickt
  // werden (Muster aus ChangeRequestForm).
  const [edits, setEdits] = useState<ChangeRequestProposal>({});
  const [hashtags, setHashtags] = useState<string[] | undefined>(
    proposedHashtags,
  );
  const [translations, setTranslations] = useState<
    Partial<Record<AppLocale, ChangeRequestProposal>>
  >({});
  const [findings, setFindings] = useState<ChangeRequestLinterFields>({});
  const [translationFindings, setTranslationFindings] = useState<
    Partial<Record<AppLocale, ChangeRequestLinterFields>>
  >({});
  const [translationErrors, setTranslationErrors] = useState<
    Partial<Record<AppLocale, Partial<Record<ChangeRequestTextField, string>>>>
  >({});

  const handle = requesterHandle ?? "";

  const errorText = (code: string): string =>
    code === "translationInvalid"
      ? t("translationInvalid")
      : t.has(`errors.${code}`)
        ? t(`errors.${code}`)
        : t("errors.invalid_input");

  const clearAdjustDrafts = () => {
    setEdits({});
    for (const field of CHANGE_REQUEST_TEXT_FIELDS) {
      clearDraft(ownKey(field));
      for (const target of otherLocales) {
        clearDraft(adjustDraftKey(changeRequestId, field, target, round));
      }
    }
  };

  /** Gemeinsamer Rahmen: Busy-Flag, Fehlercode, nach Erfolg neu laden. */
  const run = async (
    kind: Exclude<Busy, null>,
    action: () => Promise<{ ok: boolean; error?: string }>,
  ): Promise<boolean> => {
    setErrorCode(null);
    setBusy(kind);
    try {
      const result = await callAction(action);
      if (!result) return false;
      if (!result.ok) {
        if (result.error && result.error !== "linter") {
          setErrorCode(result.error);
        }
        if (result.error === "revised") {
          // Neue Fassung holen; die Meldung bleibt stehen und erklärt, warum
          // sich der Text unter dem Knopf gerade geändert hat.
          setMode("idle");
          router.refresh();
        }
        return false;
      }
      clearAdjustDrafts();
      setMode("idle");
      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  };

  /** Angepasste Fassung: Eingabe dieser Sitzung → Entwurf → Vorschlag. */
  const adjustedVersion = (): ChangeRequestProposal => {
    const stored = proposedVersions[contentLocale] ?? {};
    const version: ChangeRequestProposal = {};
    for (const field of changedFields) {
      if (field === "title") {
        version.title = edits.title ?? stored.title;
        continue;
      }
      version[field] =
        edits[field] ??
        (loadDraft(ownKey(field)) as ConstrainedDoc | null) ??
        stored[field];
    }
    return version;
  };

  const adjustInput = () => ({
    changeRequestId,
    revisedAt,
    locale: contentLocale,
    ...adjustedVersion(),
    ...(hashtags !== undefined ? { hashtags } : {}),
  });

  const handlePrepareAdjusted = async () => {
    setErrorCode(null);
    setBusy("prepare");
    try {
      const result = await callAction(() =>
        prepareAdjustedMerge(adjustInput()),
      );
      if (!result) return;
      if (!result.ok) {
        if (result.error === "linter") {
          setFindings(result.fields);
        } else {
          setErrorCode(result.error);
          if (result.error === "revised") {
            setMode("idle");
            router.refresh();
          }
        }
        return;
      }
      for (const target of otherLocales) {
        for (const field of CHANGE_REQUEST_TEXT_FIELDS) {
          clearDraft(adjustDraftKey(changeRequestId, field, target, round + 1));
        }
      }
      setRound((value) => value + 1);
      setFindings({});
      setTranslations(result.translations);
      setTranslationFindings({});
      setMode("adjustPreview");
    } finally {
      setBusy(null);
    }
  };

  const handleMergeAdjusted = async () => {
    // Zeichenlimiten der neu übersetzten Fassungen vorher prüfen.
    const issues = translationIssues<ChangeRequestTextField>(
      changeRequestProposalSchema,
      translations,
    );
    setTranslationErrors(issues);
    if (hasTranslationIssues(issues)) {
      setErrorCode("translationInvalid");
      return;
    }
    // `.then` statt `await`: Der Aufruf läuft über `run` → `callAction`, und
    // der Wächter in tests/unit/call-action.test.ts verbietet ein direktes
    // `await` auf eine Action in Komponenten.
    await run("merge", () =>
      mergeAdjustedChangeRequest({ ...adjustInput(), translations }).then(
        (result) => {
          if (!result.ok && result.error === "linter") {
            setTranslationFindings(result.versions);
            const own = result.versions[contentLocale];
            if (own) {
              // Beanstandung an der eigenen Fassung → zurück zur Bearbeitung.
              setFindings(own);
              setMode("adjust");
            }
          }
          return result;
        },
      ),
    );
  };

  const banner = (text: string) => (
    <p
      role="alert"
      className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
    >
      {text}
    </p>
  );

  const staleWarning = isStale && (
    <p
      role="alert"
      data-testid="change-request-stale"
      className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
    >
      {t("staleWarning")}
    </p>
  );

  // Antrag liegt beim Antragsteller: nur noch Ablehnen möglich (E15).
  if (status === "CHANGES_REQUESTED") {
    return (
      <div className="mt-4 flex flex-col gap-3">
        {errorCode && banner(errorText(errorCode))}
        <p
          data-testid="change-request-awaiting"
          className="font-mono text-xs text-meta"
        >
          {t("awaitingRevision", { handle })}
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            data-testid="change-request-decline"
            onClick={() =>
              void run("decline", () =>
                declineChangeRequest({ changeRequestId }),
              )
            }
            disabled={busy !== null}
            className={BUTTON_SECONDARY}
          >
            {busy === "decline" ? t("declining") : t("decline")}
          </button>
        </div>
      </div>
    );
  }

  if (mode === "idle") {
    return (
      <div className="mt-4 flex flex-col gap-3">
        {errorCode && banner(errorText(errorCode))}
        {staleWarning}
        <div
          className="flex flex-wrap gap-3"
          data-testid="change-request-actions"
        >
          <button
            type="button"
            data-testid="change-request-review"
            onClick={() => setMode("confirm")}
            disabled={busy !== null}
            className={BUTTON_PRIMARY}
          >
            {t("merge")}
          </button>
          <button
            type="button"
            data-testid="change-request-adjust"
            onClick={() => setMode("adjust")}
            disabled={busy !== null}
            className={BUTTON_SECONDARY}
          >
            {t("adjust")}
          </button>
          <button
            type="button"
            data-testid="change-request-return"
            onClick={() => setMode("return")}
            disabled={busy !== null}
            className={BUTTON_SECONDARY}
          >
            {t("return")}
          </button>
          <button
            type="button"
            data-testid="change-request-decline"
            onClick={() =>
              void run("decline", () =>
                declineChangeRequest({ changeRequestId }),
              )
            }
            disabled={busy !== null}
            className={BUTTON_SECONDARY}
          >
            {busy === "decline" ? t("declining") : t("decline")}
          </button>
        </div>
      </div>
    );
  }

  const cancelButton = (
    <button
      type="button"
      onClick={() => {
        setErrorCode(null);
        setMode("idle");
      }}
      disabled={busy !== null}
      className={BUTTON_SECONDARY}
    >
      {t("cancel")}
    </button>
  );

  if (mode === "confirm") {
    return (
      <div className="mt-4 flex max-w-[640px] flex-col gap-3">
        {errorCode && banner(errorText(errorCode))}
        {staleWarning}
        <p className="text-[15px] leading-relaxed">
          {t("confirmMergeIntro", { handle })}
        </p>
        <div className="flex flex-wrap gap-3">
          {cancelButton}
          <button
            type="button"
            data-testid="change-request-merge"
            onClick={() =>
              void run("merge", () =>
                mergeChangeRequest({ changeRequestId, revisedAt }),
              )
            }
            disabled={busy !== null}
            className={BUTTON_PRIMARY}
          >
            {busy === "merge" ? t("merging") : t("confirmMerge")}
          </button>
        </div>
      </div>
    );
  }

  if (mode === "return") {
    return (
      <div className="mt-4 flex max-w-[640px] flex-col gap-3">
        {errorCode && banner(errorText(errorCode))}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[15px] leading-relaxed">
            {t("returnIntro", { handle })}
          </legend>
          {CHANGE_REQUEST_RETURN_REASONS.map((item) => (
            <label
              key={item}
              className="flex cursor-pointer items-start gap-2.5 text-[15px]"
            >
              <input
                type="radio"
                name={`return-reason-${changeRequestId}`}
                value={item}
                data-testid={`change-request-reason-${item}`}
                checked={reason === item}
                onChange={() => setReason(item)}
                className="mt-1 accent-ink"
              />
              {t(`returnReasons.${item}`)}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-3">
          {cancelButton}
          <button
            type="button"
            data-testid="change-request-return-confirm"
            onClick={() =>
              reason &&
              void run("return", () =>
                returnChangeRequest({ changeRequestId, revisedAt, reason }),
              )
            }
            disabled={busy !== null || reason === null}
            className={BUTTON_PRIMARY}
          >
            {busy === "return" ? t("returning") : t("confirmReturn")}
          </button>
        </div>
      </div>
    );
  }

  if (!isClient) {
    // Entwürfe leben im localStorage — die Editoren rendern nur clientseitig.
    return null;
  }

  const hasFindings = Object.keys(findings).length > 0;
  const hasTranslationFindings = otherLocales.some(
    (target) => Object.keys(translationFindings[target] ?? {}).length > 0,
  );

  if (mode === "adjust") {
    return (
      <div className="mt-4 flex max-w-[640px] flex-col gap-4">
        {errorCode && banner(errorText(errorCode))}
        {staleWarning}
        {hasFindings && banner(t("linterBlockedMerge"))}
        <p className="text-[15px] leading-relaxed">
          {t("adjustIntro", { handle })}
        </p>
        <ProposalFields
          fields={changedFields}
          version={adjustedVersion()}
          onFieldChange={(field, value) => {
            setEdits((prev) => ({ ...prev, [field]: value }));
            setFindings({});
          }}
          findings={findings}
          draftKey={ownKey}
          editorKey="adjust"
          testIdPrefix="change-request-adjust"
        />
        {hashtags !== undefined && (
          <div className="flex flex-col gap-1.5">
            <HashtagInput
              tags={hashtags}
              onChange={(next) => {
                setHashtags(next);
                setFindings({});
              }}
              label={t("hashtagsField")}
            />
            {findings.hashtags && (
              <LinterFeedback findings={findings.hashtags} />
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {cancelButton}
          <button
            type="button"
            data-testid="change-request-adjust-prepare"
            onClick={() => void handlePrepareAdjusted()}
            disabled={busy !== null || hasFindings}
            className={BUTTON_PRIMARY}
          >
            {busy === "prepare" ? t("checking") : t("toPreview")}
          </button>
        </div>
      </div>
    );
  }

  // mode === "adjustPreview"
  return (
    <div className="mt-4 flex max-w-[640px] flex-col gap-4">
      {errorCode && banner(errorText(errorCode))}
      {hasTranslationFindings && banner(t("linterBlockedTranslation"))}
      <p className="text-[15px] leading-relaxed">{t("adjustPreviewIntro")}</p>
      {otherLocales.map((target) => {
        const version = translations[target];
        if (!version) {
          return null;
        }
        return (
          <div key={target} className="flex flex-col gap-3">
            <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
              {tRoot(`localeSwitcher.${target}`)}
            </span>
            <ProposalFields
              fields={changedFields}
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
                setTranslationErrors((prev) => {
                  if (!prev[target]?.[field]) {
                    return prev;
                  }
                  const nextFields = { ...prev[target] };
                  delete nextFields[field];
                  return { ...prev, [target]: nextFields };
                });
              }}
              findings={translationFindings[target] ?? {}}
              fieldErrors={translationErrors[target] ?? {}}
              draftKey={(field) =>
                adjustDraftKey(changeRequestId, field, target, round)
              }
              editorKey={`${target}-${round}`}
              testIdPrefix={`change-request-adjust-${target}`}
              labelSuffix={tRoot(`localeSwitcher.${target}`)}
            />
          </div>
        );
      })}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setMode("adjust")}
          disabled={busy !== null}
          className={BUTTON_SECONDARY}
        >
          {t("backToAdjust")}
        </button>
        <button
          type="button"
          data-testid="change-request-adjust-merge"
          onClick={() => void handleMergeAdjusted()}
          disabled={busy !== null || hasTranslationFindings}
          className={BUTTON_PRIMARY}
        >
          {busy === "merge" ? t("merging") : t("confirmAdjustedMerge")}
        </button>
      </div>
    </div>
  );
}
