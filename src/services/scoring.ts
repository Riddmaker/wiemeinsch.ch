/**
 * Ranking-Formeln als Pure Functions.
 * Definitionen: U = Upvotes, D = Downvotes, N = U + D, p = U / N,
 * S = Statements, PPR = Änderungsanträge, t = Alter in Stunden.
 */

/** 95%-Konfidenz (Wilson Lower Bound). */
const Z = 1.96;

/** Trending-Gravitation (Hacker-News-Modell). */
const GRAVITY = 1.8;

/** Unter N Stimmen gibt es keinen Consensus-Rang (Anzeige «zu wenig Stimmen»). */
export const CONSENSUS_MIN_VOTES = 10;

/**
 * Consensus = ( p + z²/2N − z·√( p(1−p)/N + z²/4N² ) ) / ( 1 + z²/N )
 * Untergrenze des Vertrauensintervalls der Zustimmungsquote: breite Zustimmung
 * schlägt laute Nische, 50/50-Polarisierung ergibt automatisch einen tiefen Wert.
 */
export function wilsonLowerBound(up: number, down: number): number {
  const n = up + down;
  if (n === 0) {
    return 0;
  }
  const p = up / n;
  const z2 = Z * Z;
  const lowerBound =
    (p + z2 / (2 * n) - Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) /
    (1 + z2 / n);
  // Float-Randfall: bei p = 0 kann numerisch −3e−17 entstehen — Score ist per
  // Definition ∈ [0, 1).
  return Math.max(0, lowerBound);
}

/**
 * Kontrovers = (U + D) ^ ( min(U,D) / max(U,D) ), 0 falls U oder D = 0.
 * Exponent misst die Balance (1.0 bei exakt 50/50), Basis das Volumen.
 */
export function controversy(up: number, down: number): number {
  if (up === 0 || down === 0) {
    return 0;
  }
  return Math.pow(up + down, Math.min(up, down) / Math.max(up, down));
}

/**
 * Trending = E / (t + 2)^1.8 mit E = N + 2·S + 3·PPR.
 * Statements und Änderungsanträge zählen mehr als blosse Votes (Anti-Ragebait).
 */
export function trending(
  votes: number,
  statements: number,
  changeRequests: number,
  ageHours: number,
): number {
  const engagement = votes + 2 * statements + 3 * changeRequests;
  return engagement / Math.pow(ageHours + 2, GRAVITY);
}

export type TicketScoreInput = {
  upvotes: number;
  downvotes: number;
  statementCount: number;
  changeRequestCount: number;
  createdAt: Date;
};

export type TicketScores = {
  scoreConsensus: number;
  scoreControversy: number;
  scoreTrending: number;
};

/**
 * Gemeinsamer Rechenweg für die Denormalisierung (Vote-Actions, Seed):
 * alle drei Scores aus den Zählern eines Tickets.
 */
export function computeTicketScores(
  ticket: TicketScoreInput,
  now: Date = new Date(),
): TicketScores {
  const ageHours = Math.max(
    0,
    (now.getTime() - ticket.createdAt.getTime()) / 3_600_000,
  );
  return {
    scoreConsensus: wilsonLowerBound(ticket.upvotes, ticket.downvotes),
    scoreControversy: controversy(ticket.upvotes, ticket.downvotes),
    scoreTrending: trending(
      ticket.upvotes + ticket.downvotes,
      ticket.statementCount,
      ticket.changeRequestCount,
      ageHours,
    ),
  };
}
