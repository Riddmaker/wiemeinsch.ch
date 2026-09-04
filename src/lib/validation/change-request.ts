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
 * Eingabe für Schritt 2 (submitChangeRequest): Original + genau die zwei
 * anderen Landessprachen (Publish-Preview).
 */
export const submitChangeRequestSchema = z
  .strictObject({
    ...draftShape,
    translations: z.partialRecord(appLocaleSchema, changeRequestProposalSchema),
  })
  .superRefine((val, ctx) => {
    requireAtLeastOneField(val, ctx);
    const expected = routing.locales.filter((locale) => locale !== val.locale);
    requireMatchingFields(val, val.translations, ctx, expected);
    if (val.translations[val.locale]) {
      ctx.addIssue({
        code: "custom",
        message: "unexpected_original_translation",
      });
    }
  });

export type SubmitChangeRequestInput = z.output<
  typeof submitChangeRequestSchema
>;

/**
 * Eingabe für den Merge (P10.3): Der Original-Autor bestätigt ALLE drei
 * Fassungen — er darf jede vor der Übernahme editieren, editierte Fassungen
 * laufen erneut durch den Civic-Linter. `locale` ist die Sprache des Autors
 * (Sprache der Linter-Begründungen), nicht die Originalsprache des Antrags.
 */
export const mergeChangeRequestSchema = z
  .strictObject({
    changeRequestId: idSchema,
    locale: appLocaleSchema,
    versions: z.partialRecord(appLocaleSchema, changeRequestProposalSchema),
    hashtags: hashtagsSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const first = val.versions[routing.locales[0]];
    for (const locale of routing.locales) {
      if (!val.versions[locale]) {
        ctx.addIssue({ code: "custom", message: `missing_version_${locale}` });
      }
    }
    if (first) {
      requireMatchingFields(first, val.versions, ctx, routing.locales);
    }
  });

export type MergeChangeRequestInput = z.output<typeof mergeChangeRequestSchema>;

/** Eingabe für das Ablehnen (P10.3) — kein Textinhalt nötig. */
export const declineChangeRequestSchema = z.strictObject({
  changeRequestId: idSchema,
});
