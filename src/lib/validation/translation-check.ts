import type { AppLocale } from "@/i18n/routing";
import type { z } from "./zod";

/**
 * Übersetzungen vor dem Publizieren prüfen (Code-Review 25.09.2026).
 *
 * Eine KI-Übersetzung kann die Zeichenlimiten verletzen: Italienisch unter
 * 200 Zeichen, Französisch über 80 im Titel. Der Server lehnte das mit einem
 * pauschalen «ungültige Eingabe» ab, ohne Feld und Sprache zu nennen. Die
 * Formulare prüfen die Fassungen deshalb vorher mit DEMSELBEN Schema wie der
 * Server und markieren genau die betroffenen Felder.
 *
 * Rückgabe je Sprache: Feld → Fehlercode (z.B. `min_200`). Fehlt eine
 * Sprache im Ergebnis, ist ihre Fassung gültig. `wholeValueField` benennt
 * das Feld, wenn die Fassung selbst der Wert ist (Statement: ein Dokument).
 */
export function translationIssues<Field extends string>(
  schema: z.ZodType,
  versions: Partial<Record<AppLocale, unknown>>,
  wholeValueField?: Field,
): Partial<Record<AppLocale, Partial<Record<Field, string>>>> {
  const issues: Partial<Record<AppLocale, Partial<Record<Field, string>>>> = {};
  for (const [locale, version] of Object.entries(versions) as [
    AppLocale,
    unknown,
  ][]) {
    const parsed = schema.safeParse(version);
    if (parsed.success) {
      continue;
    }
    const fields: Partial<Record<Field, string>> = {};
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      const field = (typeof head === "string" ? head : wholeValueField) as
        Field | undefined;
      if (field && fields[field] === undefined) {
        fields[field] = issue.message;
      }
    }
    issues[locale] = fields;
  }
  return issues;
}

/** Gibt es in irgendeiner Sprache einen Befund? */
export function hasTranslationIssues(
  issues: Partial<Record<AppLocale, Partial<Record<string, string>>>>,
): boolean {
  return Object.values(issues).some(
    (fields) => fields && Object.keys(fields).length > 0,
  );
}
