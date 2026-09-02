import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Moderations-Actions (P12, T12-Bypass-Tests): Reihenfolge
 * Identität → Rate-Limit → Zod → Berechtigung/Zustand → Mutation, und
 * sicherheitsseitig, dass ohne Admin-Flag KEINE Moderations-Action etwas
 * schreibt — auch nicht mit einem manipulierten Request. DB und Services sind
 * gemockt; die echten Fehlerklassen bleiben erhalten.
 */

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

const adminUserIdMock = vi.fn();
vi.mock("@/lib/require-admin", () => ({
  adminUserId: () => adminUserIdMock(),
}));

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

const lintFieldsMock = vi.fn();
vi.mock("@/services/content-pipeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/content-pipeline")>();
  return {
    ...actual,
    lintFields: (fields: unknown, textLocale: unknown, userLocale: unknown) =>
      lintFieldsMock(fields, textLocale, userLocale),
  };
});

const translateDocMock = vi.fn();
vi.mock("@/services/content-flow", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/content-flow")>();
  return {
    ...actual,
    translateDoc: (doc: unknown, locale: unknown) =>
      translateDocMock(doc, locale),
  };
});

const publishMocks = vi.hoisted(() => ({
  createTicket: vi.fn(),
  createStatement: vi.fn(),
  translateTicketDraft: vi.fn(),
  regionExists: vi.fn(),
  refreshStatementAggregates: vi.fn(),
}));
vi.mock("@/services/publish-content", () => publishMocks);

const txMock = vi.hoisted(() => ({
  ticket: { update: vi.fn() },
  statement: { update: vi.fn() },
  moderationCase: { update: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn() },
  statement: { findUnique: vi.fn() },
  moderationCase: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  appealLinterDecision,
  approveAppeal,
  depublishReportedContent,
  dismissCase,
  reportContent,
} from "@/actions/moderation";
import { UnauthorizedError } from "@/lib/require-user";
import {
  formatResolutionNote,
  parseResolutionNote,
} from "@/lib/validation/moderation";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";
import { MistralUnavailableError } from "@/services/mistral";

const richDoc = (chars: number): ConstrainedDoc => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "x".repeat(chars) }] },
  ],
});

const ticketDraft = {
  locale: "de" as const,
  level: "FEDERAL" as const,
  cantonId: null,
  municipalityId: null,
  title: "Tempo 30 auf Quartierstrassen einheitlich regeln",
  hashtags: ["verkehr"],
  problem: richDoc(250),
  solution: richDoc(250),
  funding: { type: "doc", content: [] } as ConstrainedDoc,
};

const statementDraft = {
  locale: "de" as const,
  ticketId: "ticket-1",
  category: "PRO" as const,
  content: richDoc(120),
};

const blockedByLinter = {
  title: [{ from: 0, to: 5, reason: "POLEMIK", explanation: "Zu polemisch." }],
};

function createData(): Record<string, unknown> {
  const call = prismaMock.moderationCase.create.mock.calls[0]?.[0] as {
    data: Record<string, unknown>;
  };
  return call.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue({ id: "user-1" });
  adminUserIdMock.mockResolvedValue("admin-1");
  checkRateLimitMock.mockResolvedValue({ ok: true });
  checkAiBudgetMock.mockResolvedValue({ ok: true });
  lintFieldsMock.mockResolvedValue(blockedByLinter);
  translateDocMock.mockResolvedValue({ fr: richDoc(120), it: richDoc(120) });
  publishMocks.regionExists.mockResolvedValue(true);
  publishMocks.createTicket.mockResolvedValue("ticket-new");
  publishMocks.createStatement.mockResolvedValue("statement-new");
  publishMocks.translateTicketDraft.mockResolvedValue({
    fr: { title: "FR", problem: richDoc(250), solution: richDoc(250) },
    it: { title: "IT", problem: richDoc(250), solution: richDoc(250) },
  });
  prismaMock.ticket.findUnique.mockResolvedValue({ status: "PUBLISHED" });
  prismaMock.statement.findUnique.mockResolvedValue({ status: "PUBLISHED" });
  prismaMock.moderationCase.findFirst.mockResolvedValue(null);
  prismaMock.moderationCase.create.mockResolvedValue({ id: "case-1" });
  prismaMock.moderationCase.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.moderationCase.update.mockResolvedValue({ id: "case-1" });
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
  );
  txMock.statement.update.mockResolvedValue({ ticketId: "ticket-1" });
  txMock.ticket.update.mockResolvedValue({ id: "ticket-1" });
  txMock.moderationCase.update.mockResolvedValue({ id: "case-1" });
});

// ---------------------------------------------------------------------------

describe("reportContent (P12.1)", () => {
  const report = {
    targetType: "STATEMENT" as const,
    targetId: "statement-1",
    reason: "BELEIDIGUNG" as const,
  };

  it("ohne Session: unauthorized, kein Rate-Limit-Verbrauch, keine Mutation", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    const result = await reportContent(report);
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("Rate-Limit greift VOR der Validierung", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });
    const result = await reportContent({ nonsense: true });
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("unbekannter Grund wird abgewiesen (fester Katalog, kein Freitext)", async () => {
    const result = await reportContent({ ...report, reason: "MIR EGAL" });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("eingeschleuste Felder lassen die Validierung scheitern", async () => {
    const result = await reportContent({
      ...report,
      reporterId: "someone-else",
      status: "RESOLVED",
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("depublizierter Inhalt ist nicht meldbar", async () => {
    prismaMock.statement.findUnique.mockResolvedValue({
      status: "DEPUBLISHED",
    });
    const result = await reportContent(report);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("erfundene Ziel-Id wird abgewiesen", async () => {
    prismaMock.statement.findUnique.mockResolvedValue(null);
    const result = await reportContent(report);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("legt einen REPORT-Fall mit Melder, Ziel und Grund an", async () => {
    const result = await reportContent(report);
    expect(result).toEqual({ ok: true });
    expect(createData()).toEqual({
      type: "REPORT",
      reporterId: "user-1",
      reason: "BELEIDIGUNG",
      statementId: "statement-1",
    });
  });

  it("Ticket-Meldung schreibt ticketId statt statementId", async () => {
    await reportContent({
      targetType: "TICKET",
      targetId: "ticket-1",
      reason: "SPAM",
    });
    expect(createData()).toEqual({
      type: "REPORT",
      reporterId: "user-1",
      reason: "SPAM",
      ticketId: "ticket-1",
    });
  });

  it("Zweitmeldung desselben Users auf dasselbe Ziel erzeugt keinen zweiten Fall", async () => {
    prismaMock.moderationCase.findFirst.mockResolvedValue({ id: "case-9" });
    const result = await reportContent(report);
    expect(result).toEqual({ ok: true });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("appealLinterDecision (P12.2)", () => {
  const appeal = { kind: "ticket" as const, draft: ticketDraft };

  it("ohne Session: unauthorized, kein Linter-Aufruf", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    const result = await appealLinterDecision(appeal);
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Rate-Limit greift vor Validierung und Linter", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });
    const result = await appealLinterDecision(appeal);
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("mitgeschickte Findings werden abgewiesen (Server lintet selbst)", async () => {
    const result = await appealLinterDecision({
      ...appeal,
      findings: [{ field: "title", reason: "POLEMIK" }],
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Fremd-Kanton im Entwurf wird abgewiesen, bevor gelintet wird", async () => {
    publishMocks.regionExists.mockResolvedValue(false);
    const result = await appealLinterDecision({
      kind: "ticket",
      draft: { ...ticketDraft, level: "CANTONAL", cantonId: 999 },
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Statement-Anfechtung auf nicht publiziertem Ticket wird abgewiesen", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ status: "DEPUBLISHED" });
    const result = await appealLinterDecision({
      kind: "statement",
      draft: statementDraft,
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("beanstandet der Linter nichts mehr, entsteht kein Fall", async () => {
    lintFieldsMock.mockResolvedValue({});
    const result = await appealLinterDecision(appeal);
    expect(result).toEqual({ ok: false, error: "not_blocked" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("Mistral-Ausfall: fail-closed, kein Fall", async () => {
    lintFieldsMock.mockRejectedValue(new MistralUnavailableError("down"));
    const result = await appealLinterDecision(appeal);
    expect(result).toEqual({ ok: false, error: "ai_unavailable" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("legt einen APPEAL-Fall mit den SERVERSEITIG ermittelten Gründen an", async () => {
    const result = await appealLinterDecision(appeal);
    expect(result).toEqual({ ok: true, caseId: "case-1" });
    const data = createData();
    expect(data.type).toBe("APPEAL");
    expect(data.reporterId).toBe("user-1");
    expect(data.reason).toBe("POLEMIK");
    expect(data.blockedContent).toEqual({
      kind: "ticket",
      draft: ticketDraft,
      findings: [
        { field: "title", reason: "POLEMIK", explanation: "Zu polemisch." },
      ],
    });
  });

  it("Doppelklick auf denselben Entwurf erzeugt keinen zweiten Fall", async () => {
    prismaMock.moderationCase.findFirst.mockResolvedValue({ id: "case-7" });
    const result = await appealLinterDecision(appeal);
    expect(result).toEqual({ ok: true, caseId: "case-7" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("Admin-Entscheide (P12.3)", () => {
  const input = { caseId: "case-1" };

  it("ohne Admin-Flag wird JEDE Moderations-Action abgewiesen — ohne Mutation", async () => {
    adminUserIdMock.mockResolvedValue(null);
    prismaMock.moderationCase.findUnique.mockResolvedValue({
      type: "REPORT",
      status: "OPEN",
      ticketId: null,
      statementId: "statement-1",
    });

    await expect(dismissCase(input)).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    await expect(depublishReportedContent(input)).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    await expect(approveAppeal(input)).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });

    expect(prismaMock.moderationCase.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.moderationCase.update).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(publishMocks.createTicket).not.toHaveBeenCalled();
  });

  it("dismissCase schliesst nur OFFENE Fälle und schreibt den Entscheid", async () => {
    const result = await dismissCase({
      caseId: "case-1",
      note: "Kein Verstoss",
    });
    expect(result).toEqual({ ok: true });
    const call = prismaMock.moderationCase.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "case-1", status: "OPEN" });
    expect(call.data.status).toBe("RESOLVED");
    expect(call.data.resolutionNote).toBe("DISMISSED: Kein Verstoss");
  });

  it("dismissCase auf einem bereits entschiedenen Fall: invalid_input", async () => {
    prismaMock.moderationCase.updateMany.mockResolvedValue({ count: 0 });
    const result = await dismissCase(input);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
  });

  it("Notiz über 500 Zeichen wird abgewiesen", async () => {
    const result = await dismissCase({
      caseId: "case-1",
      note: "x".repeat(501),
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.updateMany).not.toHaveBeenCalled();
  });

  it("eingeschleuste Felder im Entscheid lassen die Validierung scheitern", async () => {
    const result = await dismissCase({
      caseId: "case-1",
      status: "RESOLVED",
      resolutionNote: "selbst gesetzt",
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.updateMany).not.toHaveBeenCalled();
  });

  it("Depublizieren setzt den Status und zählt die Ticket-Aggregate neu", async () => {
    prismaMock.moderationCase.findUnique.mockResolvedValue({
      type: "REPORT",
      status: "OPEN",
      ticketId: null,
      statementId: "statement-1",
    });
    const result = await depublishReportedContent(input);
    expect(result).toEqual({ ok: true });
    expect(txMock.statement.update).toHaveBeenCalledWith({
      where: { id: "statement-1" },
      data: { status: "DEPUBLISHED" },
      select: { ticketId: true },
    });
    expect(publishMocks.refreshStatementAggregates).toHaveBeenCalledWith(
      txMock,
      "ticket-1",
    );
    const caseUpdate = txMock.moderationCase.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(caseUpdate.data.resolutionNote).toBe("DEPUBLISHED");
  });

  it("Depublizieren greift nicht auf einen APPEAL-Fall", async () => {
    prismaMock.moderationCase.findUnique.mockResolvedValue({
      type: "APPEAL",
      status: "OPEN",
      ticketId: null,
      statementId: null,
    });
    const result = await depublishReportedContent(input);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Freigabe publiziert den Entwurf unter dem Anfechtenden, nicht unter dem Admin", async () => {
    prismaMock.moderationCase.findUnique.mockResolvedValue({
      type: "APPEAL",
      status: "OPEN",
      reporterId: "user-1",
      blockedContent: {
        kind: "ticket",
        draft: ticketDraft,
        findings: [{ field: "title", reason: "POLEMIK" }],
      },
    });
    const result = await approveAppeal(input);
    expect(result).toEqual({ ok: true });
    expect(publishMocks.createTicket).toHaveBeenCalledTimes(1);
    expect(publishMocks.createTicket.mock.calls[0]?.[0]).toBe("user-1");
    const caseUpdate = prismaMock.moderationCase.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(caseUpdate.data.status).toBe("RESOLVED");
    expect(caseUpdate.data.resolutionNote).toBe("APPEAL_APPROVED");
    expect(caseUpdate.data.ticketId).toBe("ticket-new");
  });

  it("Freigabe eines Statement-Entwurfs publiziert über denselben Weg", async () => {
    prismaMock.moderationCase.findUnique.mockResolvedValue({
      type: "APPEAL",
      status: "OPEN",
      reporterId: "user-2",
      blockedContent: {
        kind: "statement",
        draft: statementDraft,
        findings: [{ field: "content", reason: "BELEIDIGUNG" }],
      },
    });
    const result = await approveAppeal(input);
    expect(result).toEqual({ ok: true });
    expect(publishMocks.createStatement.mock.calls[0]?.[0]).toBe("user-2");
    const caseUpdate = prismaMock.moderationCase.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(caseUpdate.data.statementId).toBe("statement-new");
  });

  it("unlesbarer blockedContent wird nicht publiziert", async () => {
    prismaMock.moderationCase.findUnique.mockResolvedValue({
      type: "APPEAL",
      status: "OPEN",
      reporterId: "user-1",
      blockedContent: { kind: "ticket", draft: { title: "zu kurz" } },
    });
    const result = await approveAppeal(input);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(publishMocks.createTicket).not.toHaveBeenCalled();
  });

  it("Freigabe eines bereits entschiedenen Falls wird abgewiesen", async () => {
    prismaMock.moderationCase.findUnique.mockResolvedValue({
      type: "APPEAL",
      status: "RESOLVED",
      reporterId: "user-1",
      blockedContent: {
        kind: "ticket",
        draft: ticketDraft,
        findings: [],
      },
    });
    const result = await approveAppeal(input);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(publishMocks.createTicket).not.toHaveBeenCalled();
  });

  it("Übersetzungs-Ausfall bei der Freigabe: fail-closed, Fall bleibt offen", async () => {
    prismaMock.moderationCase.findUnique.mockResolvedValue({
      type: "APPEAL",
      status: "OPEN",
      reporterId: "user-1",
      blockedContent: {
        kind: "ticket",
        draft: ticketDraft,
        findings: [{ field: "title", reason: "POLEMIK" }],
      },
    });
    publishMocks.translateTicketDraft.mockRejectedValue(
      new MistralUnavailableError("down"),
    );
    const result = await approveAppeal(input);
    expect(result).toEqual({ ok: false, error: "ai_unavailable" });
    expect(publishMocks.createTicket).not.toHaveBeenCalled();
    expect(prismaMock.moderationCase.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("resolutionNote (Entscheid + Notiz in einer Spalte)", () => {
  it("Roundtrip mit Notiz", () => {
    const value = formatResolutionNote("DEPUBLISHED", "Beleidigung bestätigt");
    expect(parseResolutionNote(value)).toEqual({
      decision: "DEPUBLISHED",
      note: "Beleidigung bestätigt",
    });
  });

  it("Roundtrip ohne Notiz", () => {
    expect(parseResolutionNote(formatResolutionNote("DISMISSED"))).toEqual({
      decision: "DISMISSED",
      note: null,
    });
  });

  it("Altlast ohne Präfix bleibt als Notiz erhalten", () => {
    expect(parseResolutionNote("nur eine Notiz")).toEqual({
      decision: null,
      note: "nur eine Notiz",
    });
  });
});
