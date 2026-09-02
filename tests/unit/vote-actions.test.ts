import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-Action-Tests für Votes (P8.3, T8 Bypass-Tests): Auth/Rate-Limit/
 * Zod-Reihenfolge, E1-Verhalten (neu → create, gleich → zurückziehen,
 * anders → umschalten) und die transaktionale Score-Denormalisierung.
 * DB ist gemockt; die Scores rechnet der echte scoring-Service.
 */

// Die Actions nutzen authenticatedUserId (geteilt seit P9) — der Mock bildet
// dessen Vertrag auf den gemockten Guard ab; die Fehler-Zuordnung selbst
// prüft tests/unit/require-user.test.ts.
const requireUserMock = vi.fn();
vi.mock("@/lib/require-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/require-user")>();
  return {
    ...actual,
    requireUser: () => requireUserMock(),
    authenticatedUserId: async () => {
      try {
        return ((await requireUserMock()) as { id: string }).id;
      } catch (e) {
        if (e instanceof actual.UnauthorizedError) {
          return null;
        }
        throw e;
      }
    },
  };
});

const checkRateLimitMock = vi.fn();
const checkAiBudgetMock = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (opts: unknown) => checkRateLimitMock(opts),
  // Zweite Limit-Schicht der AI-Endpunkte (P13.3).
  checkAiBudget: () => checkAiBudgetMock(),
  checkClientIpRateLimit: () => checkAiBudgetMock(),
  getClientIp: () => "direct",
  UNTRUSTED_CLIENT_IP: "direct",
  AI_IP_BUDGET: { scope: "ai-ip", limit: 60, windowSeconds: 3600 },
}));

// Transaktions-Client: $transaction(fn) führt fn mit dem tx-Mock aus.
const txMock = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn(), update: vi.fn() },
  ticketVote: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
  statement: { findUnique: vi.fn(), update: vi.fn() },
  statementVote: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
}));
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { voteOnStatement, voteOnTicket } from "@/actions/votes";
import { controversy, trending, wilsonLowerBound } from "@/services/scoring";

const TICKET_CREATED_AT = new Date(Date.now() - 5 * 3_600_000); // 5 h alt

function mockTicket(overrides: Record<string, unknown> = {}) {
  txMock.ticket.findUnique.mockResolvedValue({
    status: "PUBLISHED",
    statementCount: 2,
    changeRequestCount: 1,
    createdAt: TICKET_CREATED_AT,
    ...overrides,
  });
}

/** ▲/▼-Zählerstand, den die Transaktion nach der Mutation "zählt". */
function mockCounts(up: number, down: number) {
  txMock.ticketVote.count.mockImplementation(
    async ({ where }: { where: { value: "UP" | "DOWN" } }) =>
      where.value === "UP" ? up : down,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue({ id: "user-1" });
  checkRateLimitMock.mockResolvedValue({ ok: true });
  checkAiBudgetMock.mockResolvedValue({ ok: true });
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof txMock) => unknown) => fn(txMock),
  );
  txMock.ticketVote.findUnique.mockResolvedValue(null);
  txMock.statementVote.findUnique.mockResolvedValue(null);
});

describe("voteOnTicket — Reihenfolge & Bypass-Schutz", () => {
  it("ohne Session: unauthorized, keine Transaktion", async () => {
    requireUserMock.mockRejectedValue(
      new (await import("@/lib/require-user")).UnauthorizedError(),
    );
    const result = await voteOnTicket({ ticketId: "t1", value: "UP" });
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Rate-Limit überschritten: rate_limited, keine Transaktion", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const result = await voteOnTicket({ ticketId: "t1", value: "UP" });
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Zod-Bypass (unbekannter Wert / Zusatzfeld): invalid_input ohne DB", async () => {
    expect(await voteOnTicket({ ticketId: "t1", value: "SUPER" })).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(
      await voteOnTicket({ ticketId: "t1", value: "UP", extra: true }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("unbekanntes oder nicht publiziertes Ticket: invalid_input", async () => {
    txMock.ticket.findUnique.mockResolvedValue(null);
    expect(await voteOnTicket({ ticketId: "nope", value: "UP" })).toEqual({
      ok: false,
      error: "invalid_input",
    });

    mockTicket({ status: "HIDDEN" });
    expect(await voteOnTicket({ ticketId: "t1", value: "UP" })).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(txMock.ticketVote.upsert).not.toHaveBeenCalled();
  });
});

describe("voteOnTicket — E1-Verhalten & Score-Denormalisierung", () => {
  it("neue Stimme: Upsert, Zähler aus der Vote-Tabelle, alle drei Scores", async () => {
    mockTicket();
    mockCounts(11, 3);

    const result = await voteOnTicket({ ticketId: "t1", value: "UP" });

    expect(txMock.ticketVote.upsert).toHaveBeenCalledWith({
      where: { userId_ticketId: { userId: "user-1", ticketId: "t1" } },
      create: { userId: "user-1", ticketId: "t1", value: "UP" },
      update: { value: "UP" },
    });
    expect(txMock.ticketVote.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      upvotes: 11,
      downvotes: 3,
      myVote: "UP",
    });

    const update = txMock.ticket.update.mock.calls[0]?.[0] as {
      data: Record<string, number>;
    };
    expect(update.data.upvotes).toBe(11);
    expect(update.data.downvotes).toBe(3);
    expect(update.data.scoreConsensus).toBeCloseTo(wilsonLowerBound(11, 3), 12);
    expect(update.data.scoreControversy).toBeCloseTo(controversy(11, 3), 12);
    // Trending mit S=2, PPR=1 aus dem Ticket und Alter ≈ 5 h.
    expect(update.data.scoreTrending).toBeCloseTo(trending(14, 2, 1, 5), 3);
  });

  it("gleicher Wert nochmals: Stimme wird zurückgezogen (E1)", async () => {
    mockTicket();
    txMock.ticketVote.findUnique.mockResolvedValue({ value: "UP" });
    mockCounts(10, 3);

    const result = await voteOnTicket({ ticketId: "t1", value: "UP" });

    expect(txMock.ticketVote.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", ticketId: "t1", value: "UP" },
    });
    expect(txMock.ticketVote.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      upvotes: 10,
      downvotes: 3,
      myVote: null,
    });
  });

  it("anderer Wert: Stimme wird umgeschaltet, nie eine zweite Zeile (E1)", async () => {
    mockTicket();
    txMock.ticketVote.findUnique.mockResolvedValue({ value: "UP" });
    mockCounts(10, 4);

    const result = await voteOnTicket({ ticketId: "t1", value: "DOWN" });

    expect(txMock.ticketVote.upsert).toHaveBeenCalledWith({
      where: { userId_ticketId: { userId: "user-1", ticketId: "t1" } },
      create: { userId: "user-1", ticketId: "t1", value: "DOWN" },
      update: { value: "DOWN" },
    });
    expect(txMock.ticketVote.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      upvotes: 10,
      downvotes: 4,
      myVote: "DOWN",
    });
  });
});

describe("voteOnStatement", () => {
  it("aktualisiert nur die Statement-Zähler — keine Ticket-Scores", async () => {
    txMock.statement.findUnique.mockResolvedValue({ status: "PUBLISHED" });
    txMock.statementVote.count.mockImplementation(
      async ({ where }: { where: { value: "UP" | "DOWN" } }) =>
        where.value === "UP" ? 7 : 2,
    );

    const result = await voteOnStatement({ statementId: "s1", value: "UP" });

    expect(result).toEqual({
      ok: true,
      upvotes: 7,
      downvotes: 2,
      myVote: "UP",
    });
    expect(txMock.statement.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { upvotes: 7, downvotes: 2 },
    });
    expect(txMock.ticket.update).not.toHaveBeenCalled();
  });

  it("gleicher Wert nochmals: zurückziehen auch bei Statements (E1)", async () => {
    txMock.statement.findUnique.mockResolvedValue({ status: "PUBLISHED" });
    txMock.statementVote.findUnique.mockResolvedValue({ value: "DOWN" });
    txMock.statementVote.count.mockResolvedValue(0);

    const result = await voteOnStatement({ statementId: "s1", value: "DOWN" });

    expect(txMock.statementVote.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", statementId: "s1", value: "DOWN" },
    });
    expect(result).toEqual({
      ok: true,
      upvotes: 0,
      downvotes: 0,
      myVote: null,
    });
  });

  it("unbekanntes Statement: invalid_input ohne Mutation", async () => {
    txMock.statement.findUnique.mockResolvedValue(null);
    expect(await voteOnStatement({ statementId: "nope", value: "UP" })).toEqual(
      { ok: false, error: "invalid_input" },
    );
    expect(txMock.statementVote.upsert).not.toHaveBeenCalled();
  });
});
