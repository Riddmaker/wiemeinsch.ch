import type { AppLocale } from "@/i18n/routing";
import { toAppLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { pickTranslation } from "@/lib/translations";
import {
  ACTIVE_CHANGE_REQUEST_STATUSES,
  CHANGE_REQUEST_TEXT_FIELDS,
  type ChangeRequestProposal,
  type ChangeRequestReturnReason,
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
 *
 * E15 (14.09.2026): Anträge können zur Überarbeitung zurückgegeben,
 * überarbeitet, zurückgezogen und angepasst übernommen werden. Die
 * übernommene Fassung steht dann neben dem Vorschlag — die Anzeige zeigt,
 * was vom Antragsteller stammt und was der Ticket-Autor angepasst hat.
 */

export type ChangeRequestStatus =
  "OPEN" | "CHANGES_REQUESTED" | "MERGED" | "DECLINED" | "WITHDRAWN";

/** Läuft der Antrag noch (offen oder in Überarbeitung)? */
export function isActiveStatus(status: ChangeRequestStatus): boolean {
  return (ACTIVE_CHANGE_REQUEST_STATUSES as readonly string[]).includes(status);
}

export type ChangeRequestEntry = {
  id: string;
  /** Laufende Nummer innerhalb des Tickets, 1-basiert. */
  number: number;
  status: ChangeRequestStatus;
  authorId: string;
  authorHandle: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  /** E15: Grund und Zeitpunkt der Rückgabe — nur solange in Überarbeitung. */
  returnReason: ChangeRequestReturnReason | null;
  returnedAt: Date | null;
  /** E15: letzte Überarbeitung durch den Antragsteller. */
  revisedAt: Date | null;
  /** E15: Der Ticket-Autor hat den Vorschlag vor der Übernahme angepasst. */
  mergedWithEdits: boolean;
  /** E15: übernommene Fassung in der Lese-Sprache (nur bei Anpassungen). */
  merged?: ChangeRequestProposal;
  /** E15: übernommene Hashtags (nur bei Anpassungen, die sie betreffen). */
  mergedHashtags?: string[];
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
   * Alle drei Fassungen — nur für den Ticket-Autor (Entscheid) und den
   * Antragsteller selbst (Überarbeiten, E15) gesetzt.
   */
  versions?: Partial<Record<AppLocale, ChangeRequestProposal>>;
};

type TranslationRow = {
  title: string | null;
  problem: unknown;
  solution: unknown;
  funding: unknown;
};

type MergedTranslationRow = {
  mergedTitle: string | null;
  mergedProblem: unknown;
  mergedSolution: unknown;
  mergedFunding: unknown;
};

/**
 * DB-Zeile → Vorschlag; NULL-Spalten fallen weg («Feld unverändert»).
 * Geteilt mit den Server Actions, die den gespeicherten Vorschlag
 * übernehmen bzw. mit einer Anpassung vergleichen (E15).
 */
export function storedProposal(row: TranslationRow): ChangeRequestProposal {
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

/** Übernommene Fassung einer Sprachzeile (E15) — gleiche Regeln. */
function mergedProposal(row: MergedTranslationRow): ChangeRequestProposal {
  return storedProposal({
    title: row.mergedTitle,
    problem: row.mergedProblem,
    solution: row.mergedSolution,
    funding: row.mergedFunding,
  });
}

/** Gespeicherte Hashtag-Liste (JSON) defensiv lesen. */
export function storedHashtags(value: unknown): string[] | undefined {
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
  /** Betrachter — der Antragsteller bekommt seine Fassungen zum Überarbeiten. */
  viewerId: string | null;
  /** true für den Ticket-Autor: liefert die Fassungen aller Anträge mit. */
  isTicketAuthor: boolean;
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
    // Depubliziert (Moderation): nicht anzeigen. Die laufende Nummer zählt
    // ihn aber mit — sonst verschöben sich «#N» der übrigen Anträge und die
    // Co-Autor-Zeilen, die darauf verweisen.
    if (row.contentStatus === "DEPUBLISHED") {
      return;
    }
    const version = pickTranslation(row.translations, opts.displayLocale);
    if (!version) {
      // Fassung fehlt (Datenfehler) — Antrag überspringen statt leer rendern.
      return;
    }
    const display = storedProposal(version);
    const hashtags = storedHashtags(row.hashtags);
    const mergedHashtags = row.mergedWithEdits
      ? storedHashtags(row.mergedHashtags)
      : undefined;

    // Massgeblich ist die ORIGINAL-Fassung: Sie legt fest, welche Felder der
    // Antrag betrifft; Übersetzungen tragen dieselben Felder.
    const original =
      row.translations.find((item) => item.isOriginal) ?? version;
    const originalProposal = storedProposal(original);
    const changedFields = CHANGE_REQUEST_TEXT_FIELDS.filter(
      (field) => originalProposal[field] !== undefined,
    );

    let versions: Partial<Record<AppLocale, ChangeRequestProposal>> | undefined;
    if (opts.isTicketAuthor || row.authorId === opts.viewerId) {
      versions = {};
      for (const item of row.translations) {
        versions[toAppLocale(item.locale)] = storedProposal(item);
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
      returnReason: row.returnReason,
      returnedAt: row.returnedAt,
      revisedAt: row.revisedAt,
      mergedWithEdits: row.mergedWithEdits,
      ...(row.mergedWithEdits ? { merged: mergedProposal(version) } : {}),
      ...(mergedHashtags ? { mergedHashtags } : {}),
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

/**
 * Anzeige-Reihenfolge (P10.2): laufende Anträge (offen oder in Überarbeitung,
 * E15) zuerst, je neueste zuoberst.
 */
export function sortForDisplay(
  entries: ChangeRequestEntry[],
): ChangeRequestEntry[] {
  return [...entries].sort((a, b) => {
    const aOpen = isActiveStatus(a.status);
    const bOpen = isActiveStatus(b.status);
    if (aOpen !== bOpen) {
      return aOpen ? -1 : 1;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}
