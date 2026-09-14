import { z } from "./zod";
import { routing } from "@/i18n/routing";
import {
  fundingSchema,
  hashtagsSchema,
  problemSchema,
  solutionSchema,
  titleSchema,
} from "./content";
import { appLocaleSchema } from "./ticket";

/**
 * Change-Request-Schemas für den Political-Pull-Request-Flow (P10). Geteilt
 * zwischen Client-Formular und Server Actions (Single Source of Truth) —
 * serverseitig die Bypass-Schutzschicht VOR dem Civic-Linter.
 *
 * E12 (04.09.2026): Ein Antrag betrifft nicht mehr nur die Lösung, sondern
 * beliebige der vier Textfelder plus die Hashtags. Jedes Feld ist optional
 * («ändert dieser Antrag nicht»), aber mindestens eines muss gesetzt sein —
 * ein Antrag ohne Änderung ist keiner. Ob sich der Inhalt vom Ticket
 * tatsächlich UNTERSCHEIDET, kann erst die Action gegen die Datenbank
 * prüfen (Fehlercode `no_changes`).
 *
 * Politische Ebene und Region bleiben bewusst aussen vor (User-Entscheid):
 * Sie definieren, WAS das Ticket ist — sie nachträglich zu ändern würde
 * bereits abgegebene Stimmen rückwirkend auf eine andere Frage umdeuten.
 * Dafür ist ein neues Ticket der ehrlichere Weg.
 */

const idSchema = z.string().min(1).max(40);

/**
 * Status, in denen ein Antrag noch «läuft» (E15): offen oder beim
 * Antragsteller zur Überarbeitung. Pro User ist je Ticket genau EIN
 * laufender Antrag erlaubt, und nur laufende Anträge lassen sich bearbeiten
 * oder zurückziehen.
 */
export const ACTIVE_CHANGE_REQUEST_STATUSES = [
  "OPEN",
  "CHANGES_REQUESTED",
] as const;

/**
 * Fester Grund-Katalog für «Zur Überarbeitung zurückgeben» (E15, User-
 * Entscheid 14.09.2026) — bewusst kein Freitext, damit kein Reply-Kanal
 * durch die Hintertür entsteht. Muss mit dem Prisma-Enum
 * `ChangeRequestReturnReason` übereinstimmen.
 */
export const CHANGE_REQUEST_RETURN_REASONS = [
  "ZU_WENIG_KONKRET",
  "WEICHT_VOM_PROBLEM_AB",
  "FINANZIERUNG_UNKLAR",
  "ZU_UMFANGREICH",
  "UEBERSETZUNG_FEHLERHAFT",
] as const;

export const returnReasonSchema = z.enum(CHANGE_REQUEST_RETURN_REASONS);
export type ChangeRequestReturnReason = z.output<typeof returnReasonSchema>;

/** Übersetzbare Felder — Hashtags fehlen hier bewusst (nicht übersetzt). */
export const CHANGE_REQUEST_TEXT_FIELDS = [
  "title",
  "problem",
  "solution",
  "funding",
] as const;

export type ChangeRequestTextField =
  (typeof CHANGE_REQUEST_TEXT_FIELDS)[number];

/** Eine vorgeschlagene Fassung: nur die Felder, die der Antrag anfasst. */
const proposalShape = {
  title: titleSchema.optional(),
  problem: problemSchema.optional(),
  solution: solutionSchema.optional(),
  // `fundingSchema` ist bereits optional (Feld darf am Ticket fehlen).
  funding: fundingSchema,
};

export const changeRequestProposalSchema = z.strictObject(proposalShape);

export type ChangeRequestProposal = z.output<
  typeof changeRequestProposalSchema
>;

/** Mindestens ein Feld — sonst trägt der Antrag keinen Vorschlag. */
function requireAtLeastOneField(
  value: { hashtags?: unknown } & Partial<
    Record<ChangeRequestTextField, unknown>
  >,
  ctx: z.RefinementCtx,
): void {
  const hasText = CHANGE_REQUEST_TEXT_FIELDS.some(
    (field) => value[field] !== undefined,
  );
  if (!hasText && value.hashtags === undefined) {
    ctx.addIssue({ code: "custom", message: "no_fields" });
  }
}

const draftShape = {
  locale: appLocaleSchema,
  ticketId: idSchema,
  /**
   * Gesetzt, wenn der Antragsteller einen EIGENEN laufenden Antrag
   * überarbeitet (E15) — dann wird dieser ersetzt statt ein neuer angelegt.
   */
  changeRequestId: idSchema.optional(),
  ...proposalShape,
  hashtags: hashtagsSchema.optional(),
};

/** Eingabe für Schritt 1 (prepareChangeRequest): Original-Fassung. */
export const changeRequestDraftSchema = z
  .strictObject(draftShape)
  .superRefine(requireAtLeastOneField);

export type ChangeRequestDraft = z.output<typeof changeRequestDraftSchema>;

/**
 * Die Übersetzungen müssen exakt dieselben Textfelder tragen wie das
 * Original — sonst käme ein Antrag durch, der auf Deutsch den Titel ändert
 * und auf Französisch die Lösung.
 */
function requireMatchingFields(
  original: Partial<Record<ChangeRequestTextField, unknown>>,
  versions: Partial<
    Record<string, Partial<Record<ChangeRequestTextField, unknown>>>
  >,
  ctx: z.RefinementCtx,
  expectedLocales: readonly string[],
): void {
  for (const locale of expectedLocales) {
    const version = versions[locale];
    if (!version) {
      ctx.addIssue({
        code: "custom",
        message: `missing_translation_${locale}`,
      });
      continue;
    }
    for (const field of CHANGE_REQUEST_TEXT_FIELDS) {
      if ((original[field] !== undefined) !== (version[field] !== undefined)) {
        ctx.addIssue({ code: "custom", message: `field_mismatch_${field}` });
      }
    }
  }
}

/**
 * Original + genau die zwei anderen Landessprachen mit denselben Feldern —
 * gemeinsame Regel für das Einreichen und für «Anpassen & übernehmen».
 */
function requireOriginalWithTranslations(
  val: {
    locale: string;
    hashtags?: unknown;
    translations: Partial<
      Record<string, Partial<Record<ChangeRequestTextField, unknown>>>
    >;
  } & Partial<Record<ChangeRequestTextField, unknown>>,
  ctx: z.RefinementCtx,
): void {
  requireAtLeastOneField(val, ctx);
  const expected = routing.locales.filter((locale) => locale !== val.locale);
  requireMatchingFields(val, val.translations, ctx, expected);
  if (val.translations[val.locale]) {
    ctx.addIssue({
      code: "custom",
      message: "unexpected_original_translation",
    });
  }
}

/**
 * Eingabe für Schritt 2 (submitChangeRequest): Original + genau die zwei
 * anderen Landessprachen (Publish-Preview).
 */
export const submitChangeRequestSchema = z
  .strictObject({
    ...draftShape,
    translations: z.partialRecord(appLocaleSchema, changeRequestProposalSchema),
  })
  .superRefine(requireOriginalWithTranslations);

export type SubmitChangeRequestInput = z.output<
  typeof submitChangeRequestSchema
>;

/**
 * Eingabe für «Übernehmen» (P10.3, seit E15 unverändert 1:1): nur die Id.
 * Der Server übernimmt die gespeicherten Fassungen — der Client kann keinen
 * Text mitschicken und damit auch keine angepasste Fassung als 1:1-Übernahme
 * ausgeben.
 */
export const mergeChangeRequestSchema = z.strictObject({
  changeRequestId: idSchema,
});

export type MergeChangeRequestInput = z.output<typeof mergeChangeRequestSchema>;

const adjustedMergeShape = {
  changeRequestId: idSchema,
  /** Sprache des Ticket-Autors — in ihr passt er den Vorschlag an. */
  locale: appLocaleSchema,
  ...proposalShape,
  hashtags: hashtagsSchema.optional(),
};

/**
 * «Anpassen & übernehmen», Schritt 1 (E15): die vom Ticket-Autor angepasste
 * Fassung in seiner Sprache. Welche Felder sie tragen DARF, prüft die Action
 * gegen den gespeicherten Antrag.
 */
export const prepareAdjustedMergeSchema = z
  .strictObject(adjustedMergeShape)
  .superRefine(requireAtLeastOneField);

export type PrepareAdjustedMergeInput = z.output<
  typeof prepareAdjustedMergeSchema
>;

/**
 * «Anpassen & übernehmen», Schritt 2 (E15): angepasste Fassung + die zwei
 * neu übersetzten (ggf. nachbearbeiteten) Fassungen aus der Preview.
 */
export const mergeAdjustedChangeRequestSchema = z
  .strictObject({
    ...adjustedMergeShape,
    translations: z.partialRecord(appLocaleSchema, changeRequestProposalSchema),
  })
  .superRefine(requireOriginalWithTranslations);

export type MergeAdjustedChangeRequestInput = z.output<
  typeof mergeAdjustedChangeRequestSchema
>;

/** Eingabe für das Ablehnen (P10.3) — kein Textinhalt nötig. */
export const declineChangeRequestSchema = z.strictObject({
  changeRequestId: idSchema,
});

/** Zur Überarbeitung zurückgeben (E15): nur ein Grund aus dem Katalog. */
export const returnChangeRequestSchema = z.strictObject({
  changeRequestId: idSchema,
  reason: returnReasonSchema,
});

/** Zurückziehen durch den Antragsteller (E15). */
export const withdrawChangeRequestSchema = z.strictObject({
  changeRequestId: idSchema,
});
