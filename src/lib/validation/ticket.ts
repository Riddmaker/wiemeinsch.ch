import { z } from "./zod";
import { routing } from "@/i18n/routing";
import {
  fundingSchema,
  hashtagsSchema,
  problemSchema,
  solutionSchema,
  titleSchema,
} from "./content";

/**
 * Ticket-Schemas für den Publish-Flow (P7.3/P7.5). Geteilt zwischen
 * Client-Formular und Server Actions (Single Source of Truth) —
 * serverseitig sind sie die Bypass-Schutzschicht VOR dem Civic-Linter.
 */

export const appLocaleSchema = z.enum(routing.locales);

const levelFieldsSchema = z.strictObject({
  level: z.enum(["FEDERAL", "CANTONAL", "MUNICIPAL"]),
  cantonId: z.number().int().positive().nullable(),
  municipalityId: z.number().int().positive().nullable(),
});

function refineLevel(
  val: z.output<typeof levelFieldsSchema>,
  ctx: z.RefinementCtx,
): void {
  if (val.level === "FEDERAL" && (val.cantonId || val.municipalityId)) {
    ctx.addIssue({ code: "custom", message: "federal_no_region" });
  }
  if (val.level === "CANTONAL" && (!val.cantonId || val.municipalityId)) {
    ctx.addIssue({ code: "custom", message: "canton_required" });
  }
  if (val.level === "MUNICIPAL" && (!val.municipalityId || val.cantonId)) {
    ctx.addIssue({ code: "custom", message: "municipality_required" });
  }
}

const contentFieldsShape = {
  title: titleSchema,
  hashtags: hashtagsSchema,
  problem: problemSchema,
  solution: solutionSchema,
  funding: fundingSchema,
};

/** Eingabe für Schritt 1 (prepareTicketPublish): Original-Fassung. */
export const ticketDraftSchema = z
  .strictObject({
    locale: appLocaleSchema,
    ...levelFieldsSchema.shape,
    ...contentFieldsShape,
  })
  .superRefine(refineLevel);

export type TicketDraft = z.output<typeof ticketDraftSchema>;

/** Eine übersetzte Fassung in der Preview (ohne Hashtags — nicht übersetzt). */
export const ticketTranslationVersionSchema = z.strictObject({
  title: titleSchema,
  problem: problemSchema,
  solution: solutionSchema,
  funding: fundingSchema,
});

export type TicketTranslationVersion = z.output<
  typeof ticketTranslationVersionSchema
>;

/**
 * Eingabe für Schritt 2 (publishTicket): Original + genau die zwei anderen
 * Landessprachen (Publish-Preview).
 */
export const publishTicketSchema = z
  .strictObject({
    locale: appLocaleSchema,
    ...levelFieldsSchema.shape,
    ...contentFieldsShape,
    translations: z.partialRecord(
      appLocaleSchema,
      ticketTranslationVersionSchema,
    ),
  })
  .superRefine((val, ctx) => {
    refineLevel(val, ctx);
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

export type PublishTicketInput = z.output<typeof publishTicketSchema>;
