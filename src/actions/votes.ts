"use server";

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { authenticatedUserId } from "@/lib/require-user";
import {
  statementVoteSchema,
  ticketVoteSchema,
  type VoteChoice,
} from "@/lib/validation/vote";
import { computeTicketScores } from "@/services/scoring";

/**
 * Vote-Actions (P8.3) — Reihenfolge zwingend wie in P7:
 * requireUser() → Rate-Limit → Zod → Mutation (transaktional).
 *
 * Entscheid E1 (29.08.2026): Umschalten UND Zurückziehen erlaubt —
 * gleicher Wert nochmals = Stimme zurückziehen (Zeile wird gelöscht),
 * anderer Wert = umschalten (Upsert); nie mehr als 1 Zeile pro User+Ziel.
 *
 * Zähler werden in der Transaktion aus der Vote-Tabelle GEZÄHLT (nicht
 * inkrementiert) — selbstheilend und race-frei; beim Ticket werden zugleich
 * alle drei Scores denormalisiert (Berechnung).
 */

export type VoteActionErrorCode =
  "unauthorized" | "rate_limited" | "invalid_input";

export type VoteResult =
  | { ok: true; upvotes: number; downvotes: number; myVote: VoteChoice | null }
  | { ok: false; error: VoteActionErrorCode };

const VOTE_RATE_LIMIT = { limit: 30, windowSeconds: 60 };

export async function voteOnTicket(input: unknown): Promise<VoteResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "ticket-vote",
    identifier: userId,
    ...VOTE_RATE_LIMIT,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = ticketVoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const { ticketId, value } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: {
        status: true,
        statementCount: true,
        changeRequestCount: true,
        createdAt: true,
      },
    });
    if (!ticket || ticket.status !== "PUBLISHED") {
      return null;
    }

    const existing = await tx.ticketVote.findUnique({
      where: { userId_ticketId: { userId, ticketId } },
      select: { value: true },
    });

    let myVote: VoteChoice | null;
    if (existing?.value === value) {
      // Zurückziehen (E1) — deleteMany ist idempotent bei Doppelklick-Races.
      await tx.ticketVote.deleteMany({ where: { userId, ticketId, value } });
      myVote = null;
    } else {
      // Neu abstimmen oder umschalten — Upsert hält die Unique-Garantie.
      await tx.ticketVote.upsert({
        where: { userId_ticketId: { userId, ticketId } },
        create: { userId, ticketId, value },
        update: { value },
      });
      myVote = value;
    }

    const upvotes = await tx.ticketVote.count({
      where: { ticketId, value: "UP" },
    });
    const downvotes = await tx.ticketVote.count({
      where: { ticketId, value: "DOWN" },
    });
    await tx.ticket.update({
      where: { id: ticketId },
      data: {
        upvotes,
        downvotes,
        ...computeTicketScores({
          upvotes,
          downvotes,
          statementCount: ticket.statementCount,
          changeRequestCount: ticket.changeRequestCount,
          createdAt: ticket.createdAt,
        }),
      },
    });

    return { upvotes, downvotes, myVote };
  });

  if (!result) {
    return { ok: false, error: "invalid_input" };
  }
  return { ok: true, ...result };
}

export async function voteOnStatement(input: unknown): Promise<VoteResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "statement-vote",
    identifier: userId,
    ...VOTE_RATE_LIMIT,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = statementVoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const { statementId, value } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    const statement = await tx.statement.findUnique({
      where: { id: statementId },
      select: { status: true },
    });
    if (!statement || statement.status !== "PUBLISHED") {
      return null;
    }

    const existing = await tx.statementVote.findUnique({
      where: { userId_statementId: { userId, statementId } },
      select: { value: true },
    });

    let myVote: VoteChoice | null;
    if (existing?.value === value) {
      await tx.statementVote.deleteMany({
        where: { userId, statementId, value },
      });
      myVote = null;
    } else {
      await tx.statementVote.upsert({
        where: { userId_statementId: { userId, statementId } },
        create: { userId, statementId, value },
        update: { value },
      });
      myVote = value;
    }

    // Statements haben nur Zähler — keine Ticket-Scores (Plan 8.3).
    const upvotes = await tx.statementVote.count({
      where: { statementId, value: "UP" },
    });
    const downvotes = await tx.statementVote.count({
      where: { statementId, value: "DOWN" },
    });
    await tx.statement.update({
      where: { id: statementId },
      data: { upvotes, downvotes },
    });

    return { upvotes, downvotes, myVote };
  });

  if (!result) {
    return { ok: false, error: "invalid_input" };
  }
  return { ok: true, ...result };
}
