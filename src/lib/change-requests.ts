import type { AppLocale } from "@/i18n/routing";
import { toAppLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { pickTranslation } from "@/lib/translations";
import {
  constrainedDocSchema,
  type ConstrainedDoc,
} from "@/lib/validation/tiptap";

/**
 * Lade-Logik für Änderungsanträge eines Tickets (P10.2), einmal pro Seite —
 * Detailseite (CO_AUTHOR-Meta + Liste) teilen sich dasselbe Resultat.
 *
 * Die laufende Nummer («Änderungsantrag #4», Styleguide Art. 6) ist die
 * Position in der chronologischen Reihenfolge pro Ticket; sie wird hier
 * abgeleitet statt gespeichert, weil Anträge nie gelöscht werden.
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
  /** Fassung in der Lese-Sprache (Fallback: Originalfassung). */
  displayDoc: unknown;
  isTranslated: boolean;
  /** 10.4: Lösung wurde seit Antragstellung geändert. */
  isStale: boolean;
  /**
   * Alle drei Fassungen für die Merge-Preview — nur gesetzt, wenn der
   * Betrachter der Original-Autor ist (Least Privilege).
   */
  versions?: Partial<Record<AppLocale, ConstrainedDoc>>;
};

export async function loadChangeRequests(opts: {
  ticketId: string;
  /** Aktueller Revisionsstand der Lösung — Basis der Stale-Erkennung. */
  solutionRevision: number;
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

    let versions: Partial<Record<AppLocale, ConstrainedDoc>> | undefined;
    if (opts.includeVersions) {
      versions = {};
      for (const item of row.translations) {
        const parsed = constrainedDocSchema.safeParse(item.solution);
        if (parsed.success) {
          versions[toAppLocale(item.locale)] = parsed.data;
        }
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
      displayDoc: version.solution,
      isTranslated: !version.isOriginal,
      isStale: row.baseSolutionRevision !== opts.solutionRevision,
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
