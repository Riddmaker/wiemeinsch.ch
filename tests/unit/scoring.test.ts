import { describe, expect, it } from "vitest";
import {
  computeTicketScores,
  CONSENSUS_MIN_VOTES,
  controversy,
  trending,
  wilsonLowerBound,
} from "@/services/scoring";
import fixtures from "./fixtures/scoring-fixtures.json";

/**
 * T8/8.2 — eigenschaftsbasierte Tests + Fixtures aus unabhängigem Rechenweg.
 *
 * Die Fixtures wurden einmalig per PostgreSQL erzeugt (nicht mit dem Code
 * unter Test), Kommando siehe unten — bei Formeländerung neu generieren:
 *
 *   docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -t' <<'SQL'
 *   WITH pairs(u, d) AS (VALUES (425,75),(5,0),(0,5),(50,50),(1,1),(100,1),(8,2),(85,15),(0,0),(3,5))
 *   SELECT u, d,
 *     CASE WHEN u+d = 0 THEN 0 ELSE
 *       ( (u::numeric/(u+d)) + (1.96*1.96)/(2*(u+d))
 *         - 1.96*sqrt(((u::numeric/(u+d))*(1-(u::numeric/(u+d))))/(u+d) + (1.96*1.96)/(4.0*(u+d)*(u+d))) )
 *       / ( 1 + (1.96*1.96)/(u+d) ) END AS wilson,
 *     CASE WHEN u = 0 OR d = 0 THEN 0
 *       ELSE power(u+d, least(u,d)::numeric/greatest(u,d)) END AS controversy
 *   FROM pairs;
 *   SQL
 *
 *   (Trending analog: (n + 2*s + 3*ppr) / power(t + 2, 1.8).)
 */

/** Deterministisches Testgitter statt Zufallswerte — reproduzierbare Läufe. */
const VOTE_GRID = [0, 1, 2, 3, 5, 8, 13, 21, 50, 137, 500, 10_000];

describe("wilsonLowerBound", () => {
  it("liegt für alle Kombinationen in [0, 1)", () => {
    for (const up of VOTE_GRID) {
      for (const down of VOTE_GRID) {
        const score = wilsonLowerBound(up, down);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThan(1);
        expect(Number.isFinite(score)).toBe(true);
      }
    }
  });

  it("belohnt Breite: 85 % bei N=500 schlägt 100 % bei N=5", () => {
    expect(wilsonLowerBound(425, 75)).toBeGreaterThan(wilsonLowerBound(5, 0));
  });

  it("bestraft 50/50-Polarisierung gegenüber klarer Zustimmung (gleiches N)", () => {
    for (const n of [10, 100, 1000]) {
      expect(wilsonLowerBound(n / 2, n / 2)).toBeLessThan(
        wilsonLowerBound(0.8 * n, 0.2 * n),
      );
    }
  });

  it("steigt bei fester Quote monoton mit dem Volumen", () => {
    let previous = wilsonLowerBound(17, 3);
    for (const factor of [10, 100, 1000]) {
      const next = wilsonLowerBound(17 * factor, 3 * factor);
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
  });
});

describe("controversy", () => {
  it("ist 0, sobald eine Seite leer ist", () => {
    for (const n of VOTE_GRID) {
      expect(controversy(n, 0)).toBe(0);
      expect(controversy(0, n)).toBe(0);
    }
  });

  it("ist bei festem Volumen maximal bei exakter Spaltung", () => {
    const n = 100;
    const balanced = controversy(n / 2, n / 2);
    for (const up of [51, 60, 75, 90, 99]) {
      expect(controversy(up, n - up)).toBeLessThan(balanced);
      // Symmetrie: Vorzeichen der Spaltung ist egal.
      expect(controversy(up, n - up)).toBeCloseTo(controversy(n - up, up), 12);
    }
  });

  it("belohnt bei gleicher Balance das grössere Volumen", () => {
    expect(controversy(500, 500)).toBeGreaterThan(controversy(50, 50));
  });

  it("ein einseitiges Ticket ist nie kontrovers, egal wie gross", () => {
    expect(controversy(1_000_000, 0)).toBe(0);
  });
});

describe("trending", () => {
  it("fällt streng monoton mit dem Alter", () => {
    let previous = trending(100, 10, 2, 0);
    for (const ageHours of [1, 5, 24, 168, 720]) {
      const next = trending(100, 10, 2, ageHours);
      expect(next).toBeLessThan(previous);
      previous = next;
    }
  });

  it("gewichtet konstruktive Arbeit höher: 1 Statement > 1 Vote, 1 PPR > 1 Statement", () => {
    expect(trending(10, 1, 0, 5)).toBeGreaterThan(trending(11, 0, 0, 5));
    expect(trending(10, 0, 1, 5)).toBeGreaterThan(trending(10, 1, 0, 5));
  });

  it("ist 0 ohne jedes Engagement", () => {
    expect(trending(0, 0, 0, 0)).toBe(0);
    expect(trending(0, 0, 0, 500)).toBe(0);
  });
});

describe("Fixtures (unabhängiger SQL-Rechenweg)", () => {
  it.each(fixtures.wilsonControversy)(
    "Wilson/Controversy für $up↑/$down↓",
    ({ up, down, wilson, controversy: expected }) => {
      expect(wilsonLowerBound(up, down)).toBeCloseTo(wilson, 10);
      expect(controversy(up, down)).toBeCloseTo(expected, 9);
    },
  );

  it.each(fixtures.trending)(
    "Trending für N=$votes S=$statements PPR=$changeRequests t=$ageHours",
    ({ votes, statements, changeRequests, ageHours, trending: expected }) => {
      expect(trending(votes, statements, changeRequests, ageHours)).toBeCloseTo(
        expected,
        10,
      );
    },
  );
});

describe("computeTicketScores", () => {
  it("denormalisiert alle drei Scores aus den Zählern", () => {
    const now = new Date("2026-08-29T12:00:00Z");
    const createdAt = new Date("2026-08-27T12:00:00Z"); // 48 h alt
    const scores = computeTicketScores(
      {
        upvotes: 425,
        downvotes: 75,
        statementCount: 23,
        changeRequestCount: 4,
        createdAt,
      },
      now,
    );
    expect(scores.scoreConsensus).toBeCloseTo(wilsonLowerBound(425, 75), 12);
    expect(scores.scoreControversy).toBeCloseTo(controversy(425, 75), 12);
    expect(scores.scoreTrending).toBeCloseTo(trending(500, 23, 4, 48), 12);
  });

  it("klemmt negatives Alter (Uhren-Skew) auf 0", () => {
    const now = new Date("2026-08-29T12:00:00Z");
    const createdAt = new Date("2026-08-29T12:05:00Z");
    const scores = computeTicketScores(
      {
        upvotes: 10,
        downvotes: 0,
        statementCount: 0,
        changeRequestCount: 0,
        createdAt,
      },
      now,
    );
    expect(scores.scoreTrending).toBeCloseTo(trending(10, 0, 0, 0), 12);
  });

  it("CONSENSUS_MIN_VOTES entspricht der Spezifikation (N < 10 ohne Rang)", () => {
    expect(CONSENSUS_MIN_VOTES).toBe(10);
  });
});
