import { z } from "./zod";
import { routing } from "@/i18n/routing";
import { solutionSchema } from "./content";
import { appLocaleSchema } from "./ticket";

/**
 * Change-Request-Schemas für den Political-Pull-Request-Flow (P10). Geteilt
 * zwischen Client-Formular und Server Actions (Single Source of Truth) —
 * serverseitig die Bypass-Schutzschicht VOR dem Civic-Linter. Ein Antrag
 * ersetzt ausschliesslich den Lösungstext, deshalb gelten exakt dieselben
 * Limiten wie für die Ticket-Lösung (200–3000 Zeichen, auch für übersetzte
 * und vom Autor beim Merge editierte Fassungen).
 */

const idSchema = z.string().min(1).max(40);

const changeRequestDraftShape = {
  locale: appLocaleSchema,
  ticketId: idSchema,
  solution: solutionSchema,
};

/** Eingabe für Schritt 1 (prepareChangeRequest): Original-Fassung. */
export const changeRequestDraftSchema = z.strictObject(changeRequestDraftShape);

export type ChangeRequestDraft = z.output<typeof changeRequestDraftSchema>;

/**
 * Eingabe für Schritt 2 (submitChangeRequest): Original + genau die zwei
 * anderen Landessprachen (Publish-Preview).
 */
export const submitChangeRequestSchema = z
  .strictObject({
    ...changeRequestDraftShape,
    translations: z.partialRecord(appLocaleSchema, solutionSchema),
  })
  .superRefine((val, ctx) => {
    const expected = routing.locales.filter((locale) => locale !== val.locale);
    for (const locale of expected) {
      if (!val.translations[locale]) {
        ctx.addIssue({
          code: "custom",
          message: `missing_translation_${locale}`,
        });
      }
    }
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
    versions: z.partialRecord(appLocaleSchema, solutionSchema),
  })
  .superRefine((val, ctx) => {
    for (const locale of routing.locales) {
      if (!val.versions[locale]) {
        ctx.addIssue({ code: "custom", message: `missing_version_${locale}` });
      }
    }
  });

export type MergeChangeRequestInput = z.output<typeof mergeChangeRequestSchema>;

/** Eingabe für das Ablehnen (P10.3) — kein Textinhalt nötig. */
export const declineChangeRequestSchema = z.strictObject({
  changeRequestId: idSchema,
});
