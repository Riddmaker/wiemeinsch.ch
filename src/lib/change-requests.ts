import type { AppLocale } from "@/i18n/routing";
import { toAppLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { pickTranslation } from "@/lib/translations";
import {
  CHANGE_REQUEST_TEXT_FIELDS,
  type ChangeRequestProposal,
  type ChangeRequestTextField,
} from "@/lib/validation/change-request";
import { constrainedDocSchema } from "@/lib/validation/tiptap";

/**
 * Lade-Logik für Änderungsanträge eines Tickets (P10.2), einmal pro Seite —
 * Detailseite (CO_AUTHOR-Meta + Liste) teilen sich dasselbe Resultat.
 *
 * Die laufende Nummer («Änderungsantrag #4», Styleguide Art. 6) ist die
 * Position in der chronologischen Reihenfolge pro Ticket; sie wird hier
 * abgeleitet statt gespeichert, weil Anträge nie gelöscht werden.
 *
 * E12 (04.09.2026): Ein Antrag kann mehrere Felder betreffen. In der
 * Datenbank ist ein nicht angefasstes Feld NULL — daraus leitet sich
 * `changedFields` ab, das die Anzeige als Chips ausweist.
 */

export type ChangeRequestStatus = "OPEN" | "MERGED" | "DECLINED";

export type ChangeRequestEntry = {
  id: string;
  /** Laufende Nummer innerhalb des Tickets, 1-basiert. */
  number: number;
  status: ChangeRequestStatus;
  authorId: string;
  authorHandle: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  originalLocale: AppLocale;
  /** Welche Textfelder der Antrag ändert (Reihenfolge wie im Formular). */
  changedFields: ChangeRequestTextField[];
  /** Vorgeschlagene Hashtags — nur gesetzt, wenn der Antrag sie ändert. */
  hashtags?: string[];
  /** Fassung in der Lese-Sprache (Fallback: Originalfassung). */
  display: ChangeRequestProposal;
  isTranslated: boolean;
  /** 10.4: Ticket-Inhalt wurde seit Antragstellung geändert. */
  isStale: boolean;
  /**
   * Alle drei Fassungen für die Merge-Preview — nur gesetzt, wenn der
   * Betrachter der Original-Autor ist (Least Privilege).
   */
  versions?: Partial<Record<AppLocale, ChangeRequestProposal>>;
};

type TranslationRow = {
  locale: string;
  isOriginal: boolean;
  title: string | null;
  problem: unknown;
  solution: unknown;
  funding: unknown;
};

/** DB-Zeile → Vorschlag; NULL-Spalten fallen weg («Feld unverändert»). */
function toProposal(row: TranslationRow): ChangeRequestProposal {
  const proposal: ChangeRequestProposal = {};
  if (row.title !== null) {
    proposal.title = row.title;
  }
  for (const field of ["problem", "solution", "funding"] as const) {
    const value = row[field];
    if (value === null || value === undefined) {
      continue;
    }
    const parsed = constrainedDocSchema.safeParse(value);
    if (parsed.success) {
      proposal[field] = parsed.data;
    }
  }
  return proposal;
}

/** Gespeicherte Hashtag-Liste (JSON) defensiv lesen. */
function toHashtags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((tag): tag is string => typeof tag === "string");
}

export async function loadChangeRequests(opts: {
  ticketId: string;
  /** Aktueller Revisionsstand des Ticket-Inhalts — Basis der Stale-Erkennung. */
  contentRevision: number;
  displayLocale: AppLocale;
  /** true für den Original-Autor: liefert die editierbaren Fassungen mit. */
  includeVersions: boolean;
}): Promise<ChangeRequestEntry[]> {
  const rows = await prisma.changeRequest.findMany({
    where: { ticketId: opts.ticketId },
    include: {
      translations: true,
      author: { select: { handle: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const entries: ChangeRequestEntry[] = [];
  rows.forEach((row, index) => {
    const version = pickTranslation(row.translations, opts.displayLocale);
    if (!version) {
      // Fassung fehlt (Datenfehler) — Antrag überspringen statt leer rendern.
      return;
    }
    const display = toProposal(version);
    const hashtags = toHashtags(row.hashtags);

    // Massgeblich ist die ORIGINAL-Fassung: Sie legt fest, welche Felder der
    // Antrag betrifft; Übersetzungen tragen dieselben Felder.
    const original =
      row.translations.find((item) => item.isOriginal) ?? version;
    const originalProposal = toProposal(original);
    const changedFields = CHANGE_REQUEST_TEXT_FIELDS.filter(
      (field) => originalProposal[field] !== undefined,
    );

    let versions: Partial<Record<AppLocale, ChangeRequestProposal>> | undefined;
    if (opts.includeVersions) {
      versions = {};
      for (const item of row.translations) {
        versions[toAppLocale(item.locale)] = toProposal(item);
      }
    }

    entries.push({
      id: row.id,
      number: index + 1,
      status: row.status as ChangeRequestStatus,
      authorId: row.authorId,
      authorHandle: row.author.handle,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      originalLocale: toAppLocale(row.originalLocale),
      changedFields,
      ...(hashtags ? { hashtags } : {}),
      display,
      isTranslated: !version.isOriginal,
      isStale: row.baseContentRevision !== opts.contentRevision,
      ...(versions ? { versions } : {}),
    });
  });

  return entries;
}

/** Anzeige-Reihenfolge (P10.2): offene Anträge zuerst, je neueste zuoberst. */
export function sortForDisplay(
  entries: ChangeRequestEntry[],
): ChangeRequestEntry[] {
  return [...entries].sort((a, b) => {
    const aOpen = a.status === "OPEN";
    const bOpen = b.status === "OPEN";
    if (aOpen !== bOpen) {
      return aOpen ? -1 : 1;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}
