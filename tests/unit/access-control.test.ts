import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ACCESS-CONTROL-MATRIX (P13.1) — die verbindliche Gegenprobe zu
 *
 * Rolle gefahren:
 *
 *   Gast · eingeloggt-fremd · eingeloggt-berechtigt · Admin
 *
 * Drei Eigenschaften werden pro Zelle geprüft, nicht nur der Fehlercode:
 *   1. Eine verbotene Zelle liefert den erwarteten Ablehnungscode.
 *   2. Eine verbotene Zelle schreibt NICHTS — jeder Schreib-Mock (Prisma und
 *      die Publish-Bausteine) bleibt bei 0 Aufrufen.
 *   3. Die erlaubte Zelle kommt durch. Ohne diese Gegenprobe wäre die Matrix
 *      auch dann grün, wenn die App jeden ablehnt (OWASP A01 andersherum).
 *
 * Zusätzlich der IDOR-Block: fremde und erfundene Ressourcen-Ids in jede
 * Action, die eine Id entgegennimmt.
 *
 * DB und AI-Services sind gemockt; die echten Zod-Schemas und Guard-Funktionen
 * laufen unverändert.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  ticket: { findUnique: vi.fn(), update: vi.fn() },
  ticketTranslation: { updateMany: vi.fn() },
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
  changeRequest: {
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  moderationCase: { update: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn(), findFirst: vi.fn() },
  statement: { findUnique: vi.fn(), findFirst: vi.fn() },
  changeRequest: { findUnique: vi.fn(), findFirst: vi.fn() },
  moderationCase: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  user: { update: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  declineChangeRequest,
  mergeChangeRequest,
  prepareChangeRequest,
  submitChangeRequest,
} from "@/actions/change-requests";
import {
  appealLinterDecision,
  approveAppeal,
  depublishReportedContent,
  dismissCase,
  reportContent,
} from "@/actions/moderation";
import { updateProfile } from "@/actions/profile";
import {
  prepareStatementPublish,
  publishStatement,
} from "@/actions/statements";
import { prepareTicketPublish, publishTicket } from "@/actions/tickets";
import { voteOnStatement, voteOnTicket } from "@/actions/votes";
import { UnauthorizedError } from "@/lib/require-user";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";

// ---------------------------------------------------------------------------
// Rollen & Fixtures
// ---------------------------------------------------------------------------

const OWNER = "owner-1";
const STRANGER = "stranger-1";
const ADMIN = "admin-1";

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

const ticketVersion = {
  title: "Titre traduit",
  problem: richDoc(250),
  solution: richDoc(250),
  funding: { type: "doc", content: [] } as ConstrainedDoc,
};

const publishTicketInput = {
  ...ticketDraft,
  translations: { fr: ticketVersion, it: ticketVersion },
};

const statementDraft = {
  locale: "de" as const,
  ticketId: "ticket-1",
  category: "PRO" as const,
  content: richDoc(120),
};

const publishStatementInput = {
  ...statementDraft,
  translations: { fr: richDoc(120), it: richDoc(120) },
};

const changeRequestDraft = {
  locale: "de" as const,
  ticketId: "ticket-1",
  solution: richDoc(250),
};

const submitChangeRequestInput = {
  ...changeRequestDraft,
  translations: { fr: richDoc(250), it: richDoc(250) },
};

const mergeInput = {
  changeRequestId: "cr-1",
  locale: "de" as const,
  versions: { de: richDoc(250), fr: richDoc(250), it: richDoc(250) },
};

const profileInput = {
  preferredLocale: "DE" as const,
  birthYear: 1990,
  gender: "D" as const,
  education: "BACHELOR" as const,
  postalCode: "3011",
  occupation: null,
};

const reportInput = {
  targetType: "STATEMENT" as const,
  targetId: "statement-1",
  reason: "BELEIDIGUNG" as const,
};

const appealInput = { kind: "ticket" as const, draft: ticketDraft };

const linterFinding = {
  title: [{ from: 0, to: 5, reason: "POLEMIK", explanation: "Zu polemisch." }],
};

/** Der APPEAL-Fall, wie ihn `appealLinterDecision` in die DB geschrieben hat. */
const storedAppealCase = {
  type: "APPEAL",
  status: "OPEN",
  reporterId: STRANGER,
  blockedContent: {
    kind: "ticket",
    draft: ticketDraft,
    findings: [{ field: "title", reason: "POLEMIK" }],
  },
};

const reportedStatementCase = {
  type: "REPORT",
  status: "OPEN",
  ticketId: null,
  statementId: "statement-1",
};

// ---------------------------------------------------------------------------
// Rollen-Schalter
// ---------------------------------------------------------------------------

function asGuest(): void {
  requireUserMock.mockRejectedValue(new UnauthorizedError());
  adminUserIdMock.mockResolvedValue(null);
}

function asUser(id: string): void {
  requireUserMock.mockResolvedValue({ id });
  adminUserIdMock.mockResolvedValue(null);
}

function asAdmin(): void {
  requireUserMock.mockResolvedValue({ id: ADMIN });
  adminUserIdMock.mockResolvedValue(ADMIN);
}

// ---------------------------------------------------------------------------
// Schreib-Wächter: JEDER mutierende Mock, den eine Action erreichen könnte
// ---------------------------------------------------------------------------

function writeSpies(): [string, ReturnType<typeof vi.fn>][] {
  return [
    ["prisma.moderationCase.create", prismaMock.moderationCase.create],
    ["prisma.moderationCase.update", prismaMock.moderationCase.update],
    ["prisma.moderationCase.updateMany", prismaMock.moderationCase.updateMany],
    ["prisma.user.update", prismaMock.user.update],
    ["prisma.$transaction", prismaMock.$transaction],
    ["tx.ticket.update", txMock.ticket.update],
    ["tx.ticketTranslation.updateMany", txMock.ticketTranslation.updateMany],
    ["tx.ticketVote.upsert", txMock.ticketVote.upsert],
    ["tx.ticketVote.deleteMany", txMock.ticketVote.deleteMany],
    ["tx.statement.update", txMock.statement.update],
    ["tx.statementVote.upsert", txMock.statementVote.upsert],
    ["tx.statementVote.deleteMany", txMock.statementVote.deleteMany],
    ["tx.changeRequest.create", txMock.changeRequest.create],
    ["tx.changeRequest.update", txMock.changeRequest.update],
    ["tx.changeRequest.updateMany", txMock.changeRequest.updateMany],
    ["tx.moderationCase.update", txMock.moderationCase.update],
    ["createTicket", publishMocks.createTicket],
    ["createStatement", publishMocks.createStatement],
  ];
}

/** Kein einziger Schreibpfad wurde betreten. */
function expectNoMutation(): void {
  const touched = writeSpies()
    .filter(([, spy]) => spy.mock.calls.length > 0)
    .map(([name]) => name);
  expect(touched).toEqual([]);
}

// ---------------------------------------------------------------------------
// Die Matrix
// ---------------------------------------------------------------------------

/**
 * `scope` = wer die Action ausführen DARF:
 *   user          — jede eingeloggte Person
 *   non-author    — jede eingeloggte Person ausser dem Ticket-Autor (PPR)
 *   ticket-author — nur der Autor des betroffenen Tickets
 *   admin         — nur Admins
 */
type Scope = "user" | "non-author" | "ticket-author" | "admin";

type ActionCell = {
  name: string;
  scope: Scope;
  run: () => Promise<unknown>;
  /** Rolle, unter der die erlaubte Gegenprobe läuft. */
  allowedAs: () => void;
  /** Zusatz-Mocks, damit die erlaubte Gegenprobe durchläuft. */
  allow?: () => void;
};

const MATRIX: ActionCell[] = [
  {
    name: "prepareTicketPublish",
    scope: "user",
    run: () => prepareTicketPublish(ticketDraft),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "publishTicket",
    scope: "user",
    run: () => publishTicket(publishTicketInput),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "prepareStatementPublish",
    scope: "user",
    run: () => prepareStatementPublish(statementDraft),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "publishStatement",
    scope: "user",
    run: () => publishStatement(publishStatementInput),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "voteOnTicket",
    scope: "user",
    run: () => voteOnTicket({ ticketId: "ticket-1", value: "UP" }),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "voteOnStatement",
    scope: "user",
    run: () => voteOnStatement({ statementId: "statement-1", value: "UP" }),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "updateProfile",
    scope: "user",
    run: () => updateProfile(profileInput),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "reportContent",
    scope: "user",
    run: () => reportContent(reportInput),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "appealLinterDecision",
    scope: "user",
    run: () => appealLinterDecision(appealInput),
    allowedAs: () => asUser(STRANGER),
    // Anfechtbar ist nur, was der Linter wirklich blockiert.
    allow: () => lintFieldsMock.mockResolvedValue(linterFinding),
  },
  {
    name: "prepareChangeRequest",
    scope: "non-author",
    run: () => prepareChangeRequest(changeRequestDraft),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "submitChangeRequest",
    scope: "non-author",
    run: () => submitChangeRequest(submitChangeRequestInput),
    allowedAs: () => asUser(STRANGER),
  },
  {
    name: "mergeChangeRequest",
    scope: "ticket-author",
    run: () => mergeChangeRequest(mergeInput),
    allowedAs: () => asUser(OWNER),
  },
  {
    name: "declineChangeRequest",
    scope: "ticket-author",
    run: () => declineChangeRequest({ changeRequestId: "cr-1" }),
    allowedAs: () => asUser(OWNER),
  },
  {
    name: "dismissCase",
    scope: "admin",
    run: () => dismissCase({ caseId: "case-1" }),
    allowedAs: asAdmin,
  },
  {
    name: "depublishReportedContent",
    scope: "admin",
    run: () => depublishReportedContent({ caseId: "case-1" }),
    allowedAs: asAdmin,
    allow: () =>
      prismaMock.moderationCase.findUnique.mockResolvedValue(
        reportedStatementCase,
      ),
  },
  {
    name: "approveAppeal",
    scope: "admin",
    run: () => approveAppeal({ caseId: "case-1" }),
    allowedAs: asAdmin,
    allow: () =>
      prismaMock.moderationCase.findUnique.mockResolvedValue(storedAppealCase),
  },
];

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  asUser(OWNER);
  checkRateLimitMock.mockResolvedValue({ ok: true });
  checkAiBudgetMock.mockResolvedValue({ ok: true });

  // Linter sauber, Übersetzungen vorhanden.
  lintFieldsMock.mockResolvedValue({});
  translateDocMock.mockResolvedValue({ fr: richDoc(250), it: richDoc(250) });
  publishMocks.regionExists.mockResolvedValue(true);
  publishMocks.createTicket.mockResolvedValue("ticket-new");
  publishMocks.createStatement.mockResolvedValue("statement-new");
  publishMocks.translateTicketDraft.mockResolvedValue({
    fr: ticketVersion,
    it: ticketVersion,
  });

  // `ticket-1` gehört OWNER und ist publiziert.
  prismaMock.ticket.findUnique.mockResolvedValue({
    status: "PUBLISHED",
    authorId: OWNER,
  });
  prismaMock.ticket.findFirst.mockResolvedValue(null);
  prismaMock.statement.findUnique.mockResolvedValue({ status: "PUBLISHED" });
  prismaMock.statement.findFirst.mockResolvedValue(null);

  // `cr-1` stammt von STRANGER und liegt auf dem Ticket von OWNER.
  prismaMock.changeRequest.findUnique.mockResolvedValue({
    status: "OPEN",
    authorId: STRANGER,
    ticketId: "ticket-1",
    ticket: { authorId: OWNER, status: "PUBLISHED" },
  });
  prismaMock.changeRequest.findFirst.mockResolvedValue(null);

  prismaMock.moderationCase.findFirst.mockResolvedValue(null);
  prismaMock.moderationCase.findUnique.mockResolvedValue(reportedStatementCase);
  prismaMock.moderationCase.create.mockResolvedValue({ id: "case-new" });
  prismaMock.moderationCase.update.mockResolvedValue({ id: "case-1" });
  prismaMock.moderationCase.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.user.update.mockResolvedValue({ id: OWNER });

  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
  );

  txMock.ticket.findUnique.mockResolvedValue({
    status: "PUBLISHED",
    authorId: OWNER,
    solutionRevision: 3,
    upvotes: 2,
    downvotes: 1,
    statementCount: 4,
    createdAt: new Date("2026-08-01T00:00:00Z"),
  });
  txMock.ticket.update.mockResolvedValue({ id: "ticket-1" });
  txMock.ticketTranslation.updateMany.mockResolvedValue({ count: 1 });
  txMock.ticketVote.findUnique.mockResolvedValue(null);
  txMock.ticketVote.upsert.mockResolvedValue({});
  txMock.ticketVote.deleteMany.mockResolvedValue({ count: 1 });
  txMock.ticketVote.count.mockResolvedValue(1);
  txMock.statement.findUnique.mockResolvedValue({ status: "PUBLISHED" });
  txMock.statement.update.mockResolvedValue({ ticketId: "ticket-1" });
  txMock.statementVote.findUnique.mockResolvedValue(null);
  txMock.statementVote.upsert.mockResolvedValue({});
  txMock.statementVote.deleteMany.mockResolvedValue({ count: 1 });
  txMock.statementVote.count.mockResolvedValue(1);
  txMock.changeRequest.findUnique.mockResolvedValue({
    status: "OPEN",
    authorId: STRANGER,
    ticketId: "ticket-1",
    ticket: { authorId: OWNER, status: "PUBLISHED" },
  });
  txMock.changeRequest.count.mockResolvedValue(0);
  txMock.changeRequest.create.mockResolvedValue({ id: "cr-new" });
  txMock.changeRequest.update.mockResolvedValue({ id: "cr-1" });
  txMock.changeRequest.updateMany.mockResolvedValue({ count: 1 });
  txMock.moderationCase.update.mockResolvedValue({ id: "case-1" });
  publishMocks.refreshStatementAggregates.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Zeile 1 — Gast: JEDE Action abgelehnt, keine einzige Mutation
// ---------------------------------------------------------------------------

describe("Rolle Gast (keine Session) — 16/16 Actions abgelehnt", () => {
  for (const cell of MATRIX) {
    it(`${cell.name}: unauthorized ohne jede Mutation`, async () => {
      asGuest();
      const result = await cell.run();
      expect(result).toEqual({ ok: false, error: "unauthorized" });
      expectNoMutation();
    });
  }
});

// ---------------------------------------------------------------------------
// Zeile 2 — eingeloggt, aber die falsche Person
// ---------------------------------------------------------------------------

describe("Rolle eingeloggt-fremd — Berechtigung entscheidet, nicht die Session", () => {
  for (const cell of MATRIX.filter((c) => c.scope === "ticket-author")) {
    it(`${cell.name}: Nicht-Autor bekommt not_author, ohne Mutation`, async () => {
      asUser(STRANGER);
      const result = await cell.run();
      expect(result).toEqual({ ok: false, error: "not_author" });
      expectNoMutation();
    });
  }

  for (const cell of MATRIX.filter((c) => c.scope === "non-author")) {
    it(`${cell.name}: der Ticket-Autor selbst bekommt own_ticket, ohne Mutation`, async () => {
      asUser(OWNER);
      const result = await cell.run();
      expect(result).toEqual({ ok: false, error: "own_ticket" });
      expectNoMutation();
    });
  }

  for (const cell of MATRIX.filter((c) => c.scope === "admin")) {
    it(`${cell.name}: eingeloggter Nicht-Admin bekommt unauthorized, ohne Mutation`, async () => {
      asUser(STRANGER);
      const result = await cell.run();
      expect(result).toEqual({ ok: false, error: "unauthorized" });
      expectNoMutation();
    });
  }
});

// ---------------------------------------------------------------------------
// Zeile 3 — Admin-Flag kommt aus der DB, nicht aus der Session
// ---------------------------------------------------------------------------

describe("Rolle Admin", () => {
  for (const cell of MATRIX.filter((c) => c.scope === "admin")) {
    it(`${cell.name}: Session behauptet Admin, DB sagt nein → unauthorized`, async () => {
      // Genau der Fall eines manipulierten Tokens: die Session trägt eine Id,
      // `adminUserId` (DB-Abfrage) liefert trotzdem null.
      requireUserMock.mockResolvedValue({ id: ADMIN });
      adminUserIdMock.mockResolvedValue(null);
      const result = await cell.run();
      expect(result).toEqual({ ok: false, error: "unauthorized" });
      expectNoMutation();
    });
  }

  it("Admin darf nicht per Admin-Recht fremde Änderungsanträge entscheiden", async () => {
    // Moderation ist NICHT dasselbe wie Autorschaft: der Admin ist hier weder
    // Ticket-Autor noch Antragsteller.
    asAdmin();
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "not_author",
    });
    expect(await declineChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: false,
      error: "not_author",
    });
    expectNoMutation();
  });
});

// ---------------------------------------------------------------------------
// Zeile 4 — Gegenprobe: die erlaubte Rolle kommt durch
// ---------------------------------------------------------------------------

describe("Gegenprobe — die berechtigte Rolle wird NICHT blockiert", () => {
  for (const cell of MATRIX) {
    it(`${cell.name}: erlaubte Rolle erhält ok`, async () => {
      cell.allowedAs();
      cell.allow?.();
      const result = (await cell.run()) as { ok: boolean };
      expect(result.ok).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// IDOR — fremde und erfundene Ressourcen-Ids
// ---------------------------------------------------------------------------

describe("IDOR — fremde/erfundene Ids in jede Action mit Id-Parameter", () => {
  it("voteOnTicket auf ein nicht existierendes Ticket: invalid_input, keine Vote-Zeile", async () => {
    txMock.ticket.findUnique.mockResolvedValue(null);
    const result = await voteOnTicket({ ticketId: "fremd-1", value: "UP" });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(txMock.ticketVote.upsert).not.toHaveBeenCalled();
    expect(txMock.ticket.update).not.toHaveBeenCalled();
  });

  it("voteOnTicket auf ein depubliziertes Ticket: invalid_input", async () => {
    txMock.ticket.findUnique.mockResolvedValue({ status: "DEPUBLISHED" });
    const result = await voteOnTicket({ ticketId: "ticket-1", value: "UP" });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(txMock.ticketVote.upsert).not.toHaveBeenCalled();
  });

  it("voteOnStatement auf ein fremdes/unbekanntes Statement: invalid_input", async () => {
    txMock.statement.findUnique.mockResolvedValue(null);
    const result = await voteOnStatement({
      statementId: "fremd-1",
      value: "UP",
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(txMock.statementVote.upsert).not.toHaveBeenCalled();
    expect(txMock.statement.update).not.toHaveBeenCalled();
  });

  it("prepareStatementPublish auf ein nicht publiziertes Ticket: invalid_input, kein AI-Call", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ status: "DEPUBLISHED" });
    const result = await prepareStatementPublish(statementDraft);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("publishStatement auf ein unbekanntes Ticket: invalid_input, kein Statement", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    const result = await publishStatement(publishStatementInput);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(publishMocks.createStatement).not.toHaveBeenCalled();
  });

  it("submitChangeRequest auf ein unbekanntes Ticket: invalid_input, kein Antrag", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    const result = await submitChangeRequest(submitChangeRequestInput);
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(txMock.changeRequest.create).not.toHaveBeenCalled();
  });

  it("mergeChangeRequest auf einen Antrag an einem FREMDEN Ticket: not_author", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      status: "OPEN",
      authorId: STRANGER,
      ticketId: "ticket-fremd",
      ticket: { authorId: "jemand-anders", status: "PUBLISHED" },
    });
    const result = await mergeChangeRequest({
      ...mergeInput,
      changeRequestId: "cr-fremd",
    });
    expect(result).toEqual({ ok: false, error: "not_author" });
    expectNoMutation();
  });

  it("declineChangeRequest auf einen unbekannten Antrag: invalid_input", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue(null);
    const result = await declineChangeRequest({ changeRequestId: "erfunden" });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expectNoMutation();
  });

  it("Der Antragsteller selbst darf seinen Antrag nicht mergen", async () => {
    // cr-1 stammt von STRANGER, das Ticket gehört OWNER.
    asUser(STRANGER);
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "not_author",
    });
    expectNoMutation();
  });

  it("reportContent auf eine erfundene Ziel-Id: invalid_input, kein Fall", async () => {
    prismaMock.statement.findUnique.mockResolvedValue(null);
    const result = await reportContent({
      ...reportInput,
      targetId: "erfunden",
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("Admin-Entscheid auf eine erfundene Fall-Id: invalid_input, keine Transaktion", async () => {
    asAdmin();
    prismaMock.moderationCase.findUnique.mockResolvedValue(null);
    prismaMock.moderationCase.updateMany.mockResolvedValue({ count: 0 });

    expect(await dismissCase({ caseId: "erfunden" })).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(await depublishReportedContent({ caseId: "erfunden" })).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(await approveAppeal({ caseId: "erfunden" })).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.moderationCase.update).not.toHaveBeenCalled();
  });

  it("depublishReportedContent greift nicht auf einen APPEAL-Fall (falscher Typ)", async () => {
    asAdmin();
    prismaMock.moderationCase.findUnique.mockResolvedValue(storedAppealCase);
    const result = await depublishReportedContent({ caseId: "case-1" });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("approveAppeal greift nicht auf einen REPORT-Fall (falscher Typ)", async () => {
    asAdmin();
    prismaMock.moderationCase.findUnique.mockResolvedValue(
      reportedStatementCase,
    );
    const result = await approveAppeal({ caseId: "case-1" });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(publishMocks.createTicket).not.toHaveBeenCalled();
    expect(prismaMock.moderationCase.update).not.toHaveBeenCalled();
  });

  it("updateProfile schreibt ausschliesslich den User aus der Session", async () => {
    asUser(STRANGER);
    expect(await updateProfile(profileInput)).toEqual({ ok: true });
    const call = prismaMock.user.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: STRANGER });
    expect(call.data).not.toHaveProperty("id");
    expect(call.data).not.toHaveProperty("isAdmin");
  });

  it("updateProfile mit eingeschleuster fremder id: invalid_input, kein Schreibvorgang", async () => {
    asUser(STRANGER);
    const result = await updateProfile({ ...profileInput, id: OWNER });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("updateProfile mit eingeschleustem isAdmin: invalid_input, kein Schreibvorgang", async () => {
    asUser(STRANGER);
    const result = await updateProfile({ ...profileInput, isAdmin: true });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("reportContent mit eingeschleustem reporterId: invalid_input, kein Fall", async () => {
    asUser(STRANGER);
    const result = await reportContent({ ...reportInput, reporterId: OWNER });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("appealLinterDecision mit mitgeschickten Findings: invalid_input", async () => {
    asUser(STRANGER);
    const result = await appealLinterDecision({
      ...appealInput,
      findings: [{ field: "title", reason: "POLEMIK" }],
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.moderationCase.create).not.toHaveBeenCalled();
  });

  it("Der Fall wird immer unter der Session-Identität angelegt, nie unter einer mitgeschickten", async () => {
    asUser(STRANGER);
    expect(await reportContent(reportInput)).toEqual({ ok: true });
    const call = prismaMock.moderationCase.create.mock.calls[0]?.[0] as {
      data: { reporterId: string };
    };
    expect(call.data.reporterId).toBe(STRANGER);
  });
});

// ---------------------------------------------------------------------------
// RATE-LIMIT-VOLLSTÄNDIGKEIT (P13.3)
//
// Bewusst in dieser Datei: der Nachweis braucht exakt dieselbe Rollen- und
// Mock-Aufstellung wie die Access-Control-Matrix, und eine zweite Kopie davon
// würde beim nächsten Schema-Wechsel auseinanderlaufen (DRY, HABIT 10).
// ---------------------------------------------------------------------------

/** Actions, die AI-Aufrufe auslösen und deshalb ZWEI Limit-Schichten haben. */
const AI_BACKED = new Set([
  "prepareTicketPublish",
  "publishTicket",
  "prepareStatementPublish",
  "publishStatement",
  "prepareChangeRequest",
  "submitChangeRequest",
  "mergeChangeRequest",
  "appealLinterDecision",
  "approveAppeal",
]);

describe("Rate-Limits — jede mutierende Action ist gedeckelt", () => {
  for (const cell of MATRIX) {
    it(`${cell.name}: erschöpftes User-Limit ⇒ rate_limited ohne Mutation`, async () => {
      cell.allowedAs();
      cell.allow?.();
      checkRateLimitMock.mockResolvedValue({
        ok: false,
        retryAfterSeconds: 42,
      });
      const result = await cell.run();
      expect(result).toEqual({ ok: false, error: "rate_limited" });
      expectNoMutation();
    });
  }

  for (const cell of MATRIX.filter((c) => AI_BACKED.has(c.name))) {
    it(`${cell.name}: erschöpftes AI-Budget ⇒ rate_limited, kein Mistral-Call`, async () => {
      cell.allowedAs();
      cell.allow?.();
      checkAiBudgetMock.mockResolvedValue({ ok: false, retryAfterSeconds: 42 });
      const result = await cell.run();
      expect(result).toEqual({ ok: false, error: "rate_limited" });
      expect(lintFieldsMock).not.toHaveBeenCalled();
      expect(translateDocMock).not.toHaveBeenCalled();
      expect(publishMocks.translateTicketDraft).not.toHaveBeenCalled();
      expectNoMutation();
    });
  }

  for (const cell of MATRIX.filter((c) => !AI_BACKED.has(c.name))) {
    it(`${cell.name}: braucht kein AI-Budget (keine AI-Kosten)`, async () => {
      cell.allowedAs();
      cell.allow?.();
      checkAiBudgetMock.mockResolvedValue({ ok: false, retryAfterSeconds: 42 });
      const result = (await cell.run()) as { ok: boolean };
      expect(result.ok).toBe(true);
    });
  }

  it("Das Limit greift VOR der Eingabevalidierung — Müll kostet keine Prüfzeit", async () => {
    asUser(STRANGER);
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 1 });
    expect(await voteOnTicket({ voellig: "kaputt" })).toEqual({
      ok: false,
      error: "rate_limited",
    });
  });

  it("Admin-Entscheide zählen auf einen eigenen Scope", async () => {
    asAdmin();
    await dismissCase({ caseId: "case-1" });
    const scopes = checkRateLimitMock.mock.calls.map(
      (call) => (call[0] as { scope: string }).scope,
    );
    expect(scopes).toContain("moderation-decision");
  });
});
