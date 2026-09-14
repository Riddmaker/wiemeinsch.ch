import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  buildRecomputeStatement,
  recomputeAllTicketScores,
  recomputeScores,
  type TicketScoreRow,
} from "@/services/scoring-recompute";
import { computeTicketScores, trending } from "@/services/scoring";

/**
 * Entscheid E9 (P14): Trending hängt am Alter, wird aber nur bei einem Ereignis
 * am Ticket geschrieben. Der Recompute rechnet alle Tickets zum SELBEN
 * Zeitpunkt neu — geprüft wird genau diese Gleichzeitigkeit, die
 * Zeitunabhängigkeit der beiden anderen Scores und dass der Schreibweg
 * `updatedAt` nicht anfasst.
 */

const NOW = new Date("2026-09-01T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const row = (
  id: string,
  overrides: Partial<Omit<TicketScoreRow, "id">> = {},
): TicketScoreRow => ({
  id,
  upvotes: 0,
  downvotes: 0,
  statementCount: 0,
  changeRequestCount: 0,
  createdAt: hoursAgo(24),
  ...overrides,
});

describe("recomputeScores", () => {
  it("liefert für jedes Ticket denselben Wert wie der gemeinsame Rechenweg", () => {
    const tickets = [
      row("a", { upvotes: 425, downvotes: 75, statementCount: 2 }),
      row("b", { upvotes: 5, downvotes: 3, createdAt: hoursAgo(200) }),
      row("c", { changeRequestCount: 16, createdAt: hoursAgo(2) }),
    ];

    expect(recomputeScores(tickets, NOW)).toEqual(
      tickets.map((ticket) => ({
        id: ticket.id,
        ...computeTicketScores(ticket, NOW),
      })),
    );
  });

  it("ist idempotent: zweiter Lauf zum selben Zeitpunkt ändert nichts", () => {
    const tickets = [
      row("a", { upvotes: 12, downvotes: 4, statementCount: 3 }),
      row("b", { upvotes: 1, downvotes: 9, changeRequestCount: 2 }),
    ];

    const first = recomputeScores(tickets, NOW);
    const second = recomputeScores(tickets, NOW);

    expect(second).toEqual(first);
  });

  it("lässt Consensus und Kontrovers unberührt, wenn nur die Zeit fortschreitet", () => {
    const tickets = [row("a", { upvotes: 425, downvotes: 75 })];

    const now = recomputeScores(tickets, NOW)[0]!;
    const inAWeek = recomputeScores(
      tickets,
      new Date(NOW.getTime() + 7 * 24 * 3_600_000),
    )[0]!;

    expect(inAWeek.scoreConsensus).toBe(now.scoreConsensus);
    expect(inAWeek.scoreControversy).toBe(now.scoreControversy);
    // Nur Trending altert — und zwar nach unten.
    expect(inAWeek.scoreTrending).toBeLessThan(now.scoreTrending);
  });

  it("korrigiert die Board-Reihenfolge, die ohne Recompute verzerrt bleibt (E9)", () => {
    // Ausgangslage wie in der DB gefunden: ein junges Ticket mit wenig
    // Aktivität trägt einen zur Erstellzeit gerechneten, hohen Trending-Wert;
    // ein altes, aktives Ticket wurde bei jedem Ereignis weiter abgewertet.
    const jungUndStill = row("still", {
      statementCount: 2,
      createdAt: hoursAgo(20),
    });
    const altUndAktiv = row("aktiv", {
      upvotes: 425,
      downvotes: 75,
      statementCount: 2,
      createdAt: hoursAgo(48),
    });
    // Stand in der DB: «still» wurde beim letzten Ereignis zum damaligen Alter
    // (hier: Anlage, 0 h) gerechnet und seither nie wieder angefasst.
    const staleTrending = trending(0, 2, 0, 0);
    const aktivTrending = trending(500, 2, 0, 48);
    expect(staleTrending).toBeGreaterThan(aktivTrending); // die Verzerrung

    const recomputed = recomputeScores([jungUndStill, altUndAktiv], NOW);
    const still = recomputed.find((t) => t.id === "still")!;
    const aktiv = recomputed.find((t) => t.id === "aktiv")!;

    // Nach dem Recompute entspricht die Ordnung wieder der Formel.
    expect(aktiv.scoreTrending).toBeGreaterThan(still.scoreTrending);
    expect(still.scoreTrending).toBeLessThan(staleTrending);
  });

  it("kommt mit einer leeren Ticket-Menge zurecht", () => {
    expect(recomputeScores([], NOW)).toEqual([]);
  });
});

describe("buildRecomputeStatement", () => {
  it("schreibt genau die drei Score-Spalten und fasst updatedAt nicht an", () => {
    const statement = buildRecomputeStatement(recomputeScores([row("a")], NOW));

    expect(statement.text).toContain('UPDATE "Ticket"');
    expect(statement.text).toContain('"score_consensus"');
    expect(statement.text).toContain('"score_controversy"');
    expect(statement.text).toContain('"score_trending"');
    // Der Recompute ändert keinen Inhalt — das Änderungsdatum darf sich nicht
    // bewegen (deshalb Roh-SQL statt `ticket.update` mit @updatedAt).
    expect(statement.text).not.toContain("updatedAt");
    expect(statement.text).not.toMatch(/\bupvotes\b|\bdownvotes\b/);
  });

  it("bindet alle Werte als Parameter, nie als String im SQL", () => {
    const rows = recomputeScores(
      [
        row("ticket-1", { upvotes: 3, downvotes: 1 }),
        row("ticket-2", { upvotes: 0, downvotes: 2 }),
      ],
      NOW,
    );
    const statement = buildRecomputeStatement(rows);

    // 2 Tickets × (id + 3 Scores) = 8 Parameter, in Zeilenreihenfolge.
    expect(statement.values).toEqual([
      "ticket-1",
      rows[0]!.scoreConsensus,
      rows[0]!.scoreControversy,
      rows[0]!.scoreTrending,
      "ticket-2",
      rows[1]!.scoreConsensus,
      rows[1]!.scoreControversy,
      rows[1]!.scoreTrending,
    ]);
    // Keine Id landet im SQL-Text — sonst wäre der Weg SQL-injizierbar.
    expect(statement.text).not.toContain("ticket-1");
    expect(statement.text.match(/\$\d+/g)).toHaveLength(8);
  });

  it("erzeugt für jedes Ticket genau eine VALUES-Zeile", () => {
    const rows = recomputeScores(
      ["a", "b", "c", "d"].map((id) => row(id)),
      NOW,
    );
    const statement = buildRecomputeStatement(rows);

    const tuples = statement.text.match(/\(\$\d+::text,/g);
    expect(tuples).toHaveLength(4);
  });
});

/**
 * Schreibweg gegen die echte DB — braucht die laufende Compose-DB.
 * Ohne DATABASE_URL (Host ohne DB-Zugang) übersprungen; vollständig im
 * Container: `docker compose exec app npx vitest run`.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "recomputeAllTicketScores (DB)",
  () => {
    const userId = "test-recompute-user";
    const ticketId = "test-recompute-ticket";
    const createdAt = hoursAgo(72);

    beforeAll(async () => {
      await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, handle: "test-recompute" },
      });
      await prisma.ticket.upsert({
        where: { id: ticketId },
        update: {},
        create: {
          id: ticketId,
          authorId: userId,
          level: "FEDERAL",
          originalLocale: "DE",
        },
      });
    });

    afterAll(async () => {
      await prisma.ticket.deleteMany({ where: { id: ticketId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    });

    it("korrigiert einen veralteten Trending-Wert und lässt updatedAt in Ruhe", async () => {
      // Zustand wie nach einem alten Ereignis: Zähler aktuell, Scores zum
      // damaligen (jungen) Alter gerechnet.
      const stale = trending(4, 2, 0, 0);
      await prisma.$executeRaw`
        UPDATE "Ticket"
        SET upvotes = 3, downvotes = 1, "statementCount" = 2,
            "changeRequestCount" = 0, "createdAt" = ${createdAt},
            score_consensus = 0, score_controversy = 0, score_trending = ${stale}
        WHERE id = ${ticketId}
      `;
      const before = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { updatedAt: true },
      });

      const result = await recomputeAllTicketScores(NOW);
      expect(result.tickets).toBeGreaterThanOrEqual(1);
      expect(result.updated).toBe(result.tickets);

      const after = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: {
          scoreConsensus: true,
          scoreControversy: true,
          scoreTrending: true,
          updatedAt: true,
        },
      });
      const expected = computeTicketScores(
        {
          upvotes: 3,
          downvotes: 1,
          statementCount: 2,
          changeRequestCount: 0,
          createdAt,
        },
        NOW,
      );

      expect(after.scoreTrending).toBeCloseTo(expected.scoreTrending, 12);
      expect(after.scoreTrending).toBeLessThan(stale);
      // Die zeitunabhängigen Scores standen auf 0 und werden mitgeheilt.
      expect(after.scoreConsensus).toBeCloseTo(expected.scoreConsensus, 12);
      expect(after.scoreControversy).toBeCloseTo(expected.scoreControversy, 12);
      // Kein Inhalt geändert ⇒ Änderungsdatum unbewegt.
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it("ist idempotent: zweiter Lauf zum selben Zeitpunkt schreibt dieselben Werte", async () => {
      await recomputeAllTicketScores(NOW);
      const first = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { scoreTrending: true, scoreConsensus: true },
      });
      await recomputeAllTicketScores(NOW);
      const second = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { scoreTrending: true, scoreConsensus: true },
      });

      expect(second).toEqual(first);
    });
  },
);
