import { z } from "./zod";
import { routing } from "@/i18n/routing";
import { statementContentSchema } from "./content";
import { appLocaleSchema } from "./ticket";

/**
 * Statement-Schemas für den Publish-Flow (P9.1). Geteilt zwischen
 * Client-Formular und Server Actions (Single Source of Truth) — serverseitig
 * die Bypass-Schutzschicht VOR dem Civic-Linter (50–500 Zeichen gelten auch
 * für abgeänderte Übersetzungs-Fassungen).
 */

export const statementCategorySchema = z.enum([
  "PRO",
  "CONTRA",
  "ERWEITERUNG",
  "FRAGE",
]);

export type StatementCategory = z.output<typeof statementCategorySchema>;

const statementDraftShape = {
  locale: appLocaleSchema,
  ticketId: z.string().min(1).max(40),
  category: statementCategorySchema,
  content: statementContentSchema,
};

/** Eingabe für Schritt 1 (prepareStatementPublish): Original-Fassung. */
export const statementDraftSchema = z.strictObject(statementDraftShape);

export type StatementDraft = z.output<typeof statementDraftSchema>;

/**
 * Eingabe für Schritt 2 (publishStatement): Original + genau die zwei anderen
 * Landessprachen (Publish-Preview).
 */
export const publishStatementSchema = z
  .strictObject({
    ...statementDraftShape,
    translations: z.partialRecord(appLocaleSchema, statementContentSchema),
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

export type PublishStatementInput = z.output<typeof publishStatementSchema>;
