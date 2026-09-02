import type { AppLocale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";
import { docToMarkdown, markdownToDoc } from "@/lib/tiptap-markdown";
import { plainText, type ConstrainedDoc } from "@/lib/validation/tiptap";
import { MistralUnavailableError } from "@/services/mistral";
import { translateText } from "@/services/translation";

/**
 * Geteilte Bausteine des Publish-Flows (P9 DRY, HABIT 10): Rich-Text-Felder
 * werden via Markdown-Marker übersetzt, damit Fettschrift und Listen die
 * Sprache wechseln, ohne das Format zu verlieren. Genutzt von tickets- UND
 * statements-Actions — kein zweiter Übersetzungs-Rundweg.
 */

/**
 * Übersetzt ein TipTap-Dokument in die zwei anderen Landessprachen.
 * Wirft MistralUnavailableError, wenn eine Ziel-Locale fehlt (die validierte
 * LLM-Antwort enthält jede Ziel-Locale — Absicherung, E8 fail-closed).
 */
export async function translateDoc(
  doc: ConstrainedDoc,
  sourceLocale: AppLocale,
): Promise<Partial<Record<AppLocale, ConstrainedDoc>>> {
  const result = await translateText({
    text: docToMarkdown(doc),
    sourceLocale,
  });
  const translations: Partial<Record<AppLocale, ConstrainedDoc>> = {};
  for (const locale of routing.locales) {
    if (locale === sourceLocale) {
      continue;
    }
    translations[locale] = markdownToDoc(requireLocale(result, locale));
  }
  return translations;
}

/**
 * Linter-Eingaben einer Ticket-Fassung im plainText-Offsetraum der
 * Highlight-API (P7.3). Geteilt zwischen Publish-Flow und Linter-Anfechtung
 * (P12.2) — beide müssen exakt dieselben Felder prüfen, sonst führt eine
 * Anfechtung Gründe auf, die im Formular nie geprüft wurden.
 */
export type TicketLintField =
  "title" | "hashtags" | "problem" | "solution" | "funding";

export function ticketLintFields(
  version: {
    title: string;
    problem: ConstrainedDoc;
    solution: ConstrainedDoc;
    funding?: ConstrainedDoc;
  },
  hashtags?: string[],
): Partial<Record<TicketLintField, string>> {
  const fields: Partial<Record<TicketLintField, string>> = {
    title: version.title,
    problem: plainText(version.problem),
    solution: plainText(version.solution),
  };
  if (version.funding) {
    fields.funding = plainText(version.funding);
  }
  if (hashtags) {
    // Hashtags werden nicht übersetzt — nur die Original-Fassung prüft sie.
    fields.hashtags = hashtags.map((tag) => `#${tag}`).join(" ");
  }
  return fields;
}

/** Ziel-Locale aus einem Übersetzungs-Resultat — fehlend = AI-Fehler (E8). */
export function requireLocale<T>(
  record: Partial<Record<AppLocale, T>>,
  locale: AppLocale,
): T {
  const value = record[locale];
  if (value === undefined) {
    throw new MistralUnavailableError("Translation misses a target locale");
  }
  return value;
}
