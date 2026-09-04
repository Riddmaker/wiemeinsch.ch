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

/**
 * Linter-Eingaben einer TEIL-Fassung (Änderungsantrag, E12): Nur die Felder,
 * die der Antrag tatsächlich ändert, gehen an den Civic-Linter. Bewusst
 * dieselben Feldnamen wie `ticketLintFields` — sonst führte eine
 * Linter-Anfechtung Gründe auf, die im Formular nie geprüft wurden.
 */
export function proposalLintFields(
  proposal: {
    title?: string;
    problem?: ConstrainedDoc;
    solution?: ConstrainedDoc;
    funding?: ConstrainedDoc;
  },
  hashtags?: string[],
): Partial<Record<TicketLintField, string>> {
  const fields: Partial<Record<TicketLintField, string>> = {};
  if (proposal.title !== undefined) {
    fields.title = proposal.title;
  }
  if (proposal.problem !== undefined) {
    fields.problem = plainText(proposal.problem);
  }
  if (proposal.solution !== undefined) {
    fields.solution = plainText(proposal.solution);
  }
  if (proposal.funding !== undefined) {
    fields.funding = plainText(proposal.funding);
  }
  if (hashtags !== undefined) {
    // Hashtags werden nicht übersetzt — nur die Original-Fassung prüft sie.
    fields.hashtags = hashtags.map((tag) => `#${tag}`).join(" ");
  }
  return fields;
}

/**
 * Übersetzt eine TEIL-Fassung in die zwei anderen Landessprachen — Feld für
 * Feld, nur was vorhanden ist. Der Titel ist ein reiner String, die übrigen
 * Felder sind TipTap-Dokumente und laufen über den Markdown-Rundweg, damit
 * Fettschrift und Listen die Sprache überstehen.
 *
 * Wirft MistralUnavailableError (E8 fail-closed).
 */
export async function translateProposal(
  proposal: {
    title?: string;
    problem?: ConstrainedDoc;
    solution?: ConstrainedDoc;
    funding?: ConstrainedDoc;
  },
  sourceLocale: AppLocale,
): Promise<
  Partial<
    Record<
      AppLocale,
      {
        title?: string;
        problem?: ConstrainedDoc;
        solution?: ConstrainedDoc;
        funding?: ConstrainedDoc;
      }
    >
  >
> {
  const [titleT, problemT, solutionT, fundingT] = await Promise.all([
    proposal.title !== undefined
      ? translateText({ text: proposal.title, sourceLocale })
      : Promise.resolve(null),
    proposal.problem !== undefined
      ? translateDoc(proposal.problem, sourceLocale)
      : Promise.resolve(null),
    proposal.solution !== undefined
      ? translateDoc(proposal.solution, sourceLocale)
      : Promise.resolve(null),
    proposal.funding !== undefined
      ? translateDoc(proposal.funding, sourceLocale)
      : Promise.resolve(null),
  ]);

  const result: Partial<
    Record<
      AppLocale,
      {
        title?: string;
        problem?: ConstrainedDoc;
        solution?: ConstrainedDoc;
        funding?: ConstrainedDoc;
      }
    >
  > = {};
  for (const locale of routing.locales) {
    if (locale === sourceLocale) {
      continue;
    }
    result[locale] = {
      ...(titleT ? { title: requireLocale(titleT, locale).trim() } : {}),
      ...(problemT ? { problem: requireLocale(problemT, locale) } : {}),
      ...(solutionT ? { solution: requireLocale(solutionT, locale) } : {}),
      ...(fundingT ? { funding: requireLocale(fundingT, locale) } : {}),
    };
  }
  return result;
}
