import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { computeTicketScores, type TicketScores } from "@/services/scoring";

/**
 * Periodische Auffrischung der denormalisierten Ticket-Scores (Entscheid E9).
 *
 * Warum es das braucht: `score_trending` hängt am Alter des Tickets, wird aber
 * nur bei einem Ereignis am Ticket geschrieben (Vote, Statement, PPR-Merge).
 * Ohne Auffrischung behält ein inaktives Ticket dauerhaft seinen «jungen»,
 * zu hohen Wert, während ein aktives bei jedem Ereignis weiter abgewertet
 * wird — die Board-Reihenfolge driftet mit der Zeit von der Formel weg
 * (Befund aus P8/P13). Dieser Service rechnet alle Tickets zum selben
 * Zeitpunkt neu, damit die indexierte Sortierung wieder der Definition
 * entspricht.
 *
 * Gerechnet wird mit `computeTicketScores` — derselbe Rechenweg wie in den
 * Server Actions und im Seed, keine zweite Formel (HABIT 10). Consensus und
 * Kontrovers sind zeitunabhängig und ergeben denselben Wert; sie werden
 * bewusst mitgeschrieben, damit ein Lauf eine eventuell abgedriftete Zeile
 * gleich mitheilt.
 *
 * Bewusst OHNE "use server": interner Baustein, kein RPC-Endpunkt.
 */

/** Postgres-Parameterlimit (65535) mit grossem Abstand unterschritten. */
const CHUNK_SIZE = 500;

export type TicketScoreRow = {
  id: string;
  upvotes: number;
  downvotes: number;
  statementCount: number;
  changeRequestCount: number;
  createdAt: Date;
};

export type RecomputedTicket = TicketScores & { id: string };

export type RecomputeResult = {
  /** Gelesene Tickets. */
  tickets: number;
  /** Von der Datenbank als geändert gemeldete Zeilen. */
  updated: number;
};

/**
 * Reiner Rechenschritt: aus den gelesenen Zählern die neuen Scores aller
 * Tickets zu EINEM Zeitpunkt. Ausgelagert, damit das Verhalten ohne Datenbank
 * geprüft werden kann — der Kern von E9 ist die Gleichzeitigkeit, nicht das
 * Schreiben.
 */
export function recomputeScores(
  tickets: readonly TicketScoreRow[],
  now: Date,
): RecomputedTicket[] {
  return tickets.map((ticket) => ({
    id: ticket.id,
    ...computeTicketScores(ticket, now),
  }));
}

/**
 * Baut das UPDATE für einen Block. Roh-SQL statt `ticket.update`: ein einziger
 * Roundtrip pro Block, und `updatedAt` (@updatedAt) bleibt unberührt — am
 * Inhalt ändert ein Recompute nichts, also darf er das Änderungsdatum nicht
 * bewegen.
 */
export function buildRecomputeStatement(
  chunk: readonly RecomputedTicket[],
): Prisma.Sql {
  const rows = chunk.map(
    // Explizite Casts: in einer VALUES-Liste kann Postgres den Typ eines
    // Parameters nicht aus dem Kontext ableiten und bricht sonst ab.
    (row) =>
      Prisma.sql`(${row.id}::text, ${row.scoreConsensus}::double precision, ${row.scoreControversy}::double precision, ${row.scoreTrending}::double precision)`,
  );
  return Prisma.sql`
    UPDATE "Ticket" AS t
    SET "score_consensus" = v.consensus,
        "score_controversy" = v.controversy,
        "score_trending" = v.trending
    FROM (VALUES ${Prisma.join(rows)}) AS v(id, consensus, controversy, trending)
    WHERE t.id = v.id
  `;
}

/** Liest alle Tickets, rechnet zu einem Zeitpunkt neu und schreibt blockweise. */
export async function recomputeAllTicketScores(
  now: Date = new Date(),
): Promise<RecomputeResult> {
  const tickets = await prisma.ticket.findMany({
    select: {
      id: true,
      upvotes: true,
      downvotes: true,
      statementCount: true,
      changeRequestCount: true,
      createdAt: true,
    },
    // Deterministische Reihenfolge: macht Läufe vergleichbar und Deadlocks
    // zwischen gleichzeitigen Läufen unwahrscheinlich.
    orderBy: { id: "asc" },
  });

  if (tickets.length === 0) {
    return { tickets: 0, updated: 0 };
  }

  const rows = recomputeScores(tickets, now);

  let updated = 0;
  for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
    updated += await prisma.$executeRaw(
      buildRecomputeStatement(rows.slice(offset, offset + CHUNK_SIZE)),
    );
  }

  return { tickets: tickets.length, updated };
}
