import { z } from "./zod";

/**
 * Vote-Eingaben (P8.3) — geteilte Zod-Schemas für Client-Aufruf und
 * Server-Action (Single Source of Truth).
 */

export const voteChoiceSchema = z.enum(["UP", "DOWN"]);
export type VoteChoice = z.infer<typeof voteChoiceSchema>;

/** cuid-Länge grosszügig begrenzt — die Existenz prüft die DB. */
const targetIdSchema = z.string().min(1).max(40);

export const ticketVoteSchema = z.strictObject({
  ticketId: targetIdSchema,
  value: voteChoiceSchema,
});
export type TicketVoteInput = z.infer<typeof ticketVoteSchema>;

export const statementVoteSchema = z.strictObject({
  statementId: targetIdSchema,
  value: voteChoiceSchema,
});
export type StatementVoteInput = z.infer<typeof statementVoteSchema>;
