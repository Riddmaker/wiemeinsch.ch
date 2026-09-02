import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-Action-Tests für den Statement-Publish-Flow (P9.1/P9.4, T9
 * Bypass-Tests): Auth/Rate-Limit/Zod/Linter-Reihenfolge, die 50–500-Zeichen-
 * Grenze auch bei umgangenem Client, und die transaktionale Persistenz inkl.
 * Trending-Neuberechnung (S fliesst in E ein). DB und AI sind gemockt.
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

const translateTextMock = vi.fn();
vi.mock("@/services/translation", () => ({
  translateText: (input: unknown) => translateTextMock(input),
}));

const txMock = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn(), update: vi.fn() },
  statement: { create: vi.fn(), count: vi.fn() },
}));
const prismaMock = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn() },
  statement: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  prepareStatementPublish,
  publishStatement,
} from "@/actions/statements";
import { UnauthorizedError } from "@/lib/require-user";
import { plainText, type ConstrainedDoc } from "@/lib/validation/tiptap";
import { MistralUnavailableError } from "@/services/mistral";
import { trending, wilsonLowerBound } from "@/services/scoring";

const doc = (chars: number): ConstrainedDoc => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "x".repeat(chars) }] },
  ],
});

const TICKET_CREATED_AT = new Date(Date.now() - 5 * 3_600_000); // 5 h alt

const draft = {
  locale: "de" as const,
  ticketId: "ticket-1",
  category: "PRO" as const,
  content: doc(120),
};

const publishInput = {
  ...draft,
  translations: { fr: doc(120), it: doc(120) },
};

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue({ id: "user-1" });
  checkRateLimitMock.mockResolvedValue({ ok: true });
  checkAiBudgetMock.mockResolvedValue({ ok: true });
  lintFieldsMock.mockResolvedValue({});
  translateTextMock.mockImplementation(async ({ text }: { text: string }) => ({
    fr: `FR: ${text}`,
    it: `IT: ${text}`,
  }));
  prismaMock.ticket.findUnique.mockResolvedValue({ status: "PUBLISHED" });
  prismaMock.statement.findFirst.mockResolvedValue(null);
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof txMock) => unknown) => fn(txMock),
  );
  txMock.ticket.findUnique.mockResolvedValue({
    status: "PUBLISHED",
    upvotes: 10,
    downvotes: 4,
    changeRequestCount: 1,
    createdAt: TICKET_CREATED_AT,
  });
  txMock.statement.create.mockResolvedValue({ id: "statement-1" });
  txMock.statement.count.mockResolvedValue(3);
});

describe("prepareStatementPublish (P9.1) — Reihenfolge & Bypass-Schutz", () => {
  it("ohne Session: unauthorized, kein Linter-/DB-Zugriff", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    expect(await prepareStatementPublish(draft)).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Rate-Limit greift VOR Zod und Linter", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });
    expect(await prepareStatementPublish(draft)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Server-Bypass 49 Zeichen: invalid_input ohne Linter-Call (T9)", async () => {
    expect(
      await prepareStatementPublish({ ...draft, content: doc(49) }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Server-Bypass 501 Zeichen: invalid_input ohne Linter-Call", async () => {
    expect(
      await prepareStatementPublish({ ...draft, content: doc(501) }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("50 Zeichen sind gültig (Grenze inklusiv)", async () => {
    const result = await prepareStatementPublish({
      ...draft,
      content: doc(50),
    });
    expect(result.ok).toBe(true);
  });

  it("unbekannte Kategorie oder Zusatzfeld: invalid_input", async () => {
    expect(
      await prepareStatementPublish({ ...draft, category: "SUPER" }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(await prepareStatementPublish({ ...draft, extra: true })).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("unbekanntes oder nicht publiziertes Ticket: invalid_input", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    expect(await prepareStatementPublish(draft)).toEqual({
      ok: false,
      error: "invalid_input",
    });

    prismaMock.ticket.findUnique.mockResolvedValue({ status: "HIDDEN" });
    expect(await prepareStatementPublish(draft)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Linter-Blockade: Findings zurück, KEINE Übersetzung", async () => {
    const findings = [{ from: 0, to: 5, reason: "POLEMIK" as const }];
    lintFieldsMock.mockResolvedValue({ content: findings });
    expect(await prepareStatementPublish(draft)).toEqual({
      ok: false,
      error: "linter",
      fields: { content: findings },
    });
    expect(translateTextMock).not.toHaveBeenCalled();
  });

  it("Happy Path: lintet den Originaltext, liefert FR+IT-Preview", async () => {
    const result = await prepareStatementPublish(draft);

    expect(lintFieldsMock).toHaveBeenCalledTimes(1);
    const [fields, textLocale, userLocale] = lintFieldsMock.mock.calls[0]!;
    expect(fields).toEqual({ content: plainText(draft.content) });
    expect(textLocale).toBe("de");
    expect(userLocale).toBe("de");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(plainText(result.translations.fr)).toContain("FR: ");
      expect(plainText(result.translations.it)).toContain("IT: ");
      expect(result.translations.de).toBeUndefined();
    }
  });

  it("Mistral-Ausfall: ai_unavailable (E8 fail-closed)", async () => {
    lintFieldsMock.mockRejectedValue(new MistralUnavailableError("down"));
    expect(await prepareStatementPublish(draft)).toEqual({
      ok: false,
      error: "ai_unavailable",
    });
  });
});

describe("publishStatement (P9.1/P9.4)", () => {
  it("ohne Session: unauthorized, keine DB-Mutation", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    expect(await publishStatement(publishInput)).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("fehlende Übersetzung: invalid_input", async () => {
    expect(
      await publishStatement({ ...draft, translations: { fr: doc(120) } }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Server-Bypass in einer Übersetzung (49 Zeichen): invalid_input", async () => {
    expect(
      await publishStatement({
        ...publishInput,
        translations: { fr: doc(49), it: doc(120) },
      }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("lintet ALLE drei Fassungen und speichert sie transaktional", async () => {
    const result = await publishStatement(publishInput);

    expect(lintFieldsMock).toHaveBeenCalledTimes(3);
    expect(
      lintFieldsMock.mock.calls.map(([, textLocale]) => textLocale),
    ).toEqual(expect.arrayContaining(["de", "fr", "it"]));

    const created = txMock.statement.create.mock.calls[0]?.[0] as {
      data: {
        ticketId: string;
        authorId: string;
        category: string;
        originalLocale: string;
        translations: { create: { locale: string; isOriginal: boolean }[] };
      };
    };
    expect(created.data).toMatchObject({
      ticketId: "ticket-1",
      authorId: "user-1",
      category: "PRO",
      originalLocale: "DE",
    });
    const rows = created.data.translations.create;
    expect(rows.map((row) => row.locale).sort()).toEqual(["DE", "FR", "IT"]);
    expect(rows.filter((row) => row.isOriginal)).toHaveLength(1);
    expect(result).toEqual({ ok: true, statementId: "statement-1" });
  });

  it("Linter beanstandet eine Übersetzung: versions zurück, keine Mutation", async () => {
    const findings = [{ from: 0, to: 4, reason: "RAGEBAIT" as const }];
    lintFieldsMock.mockImplementation(async (_fields, textLocale: string) =>
      textLocale === "fr" ? { content: findings } : {},
    );
    expect(await publishStatement(publishInput)).toEqual({
      ok: false,
      error: "linter",
      versions: { fr: { content: findings } },
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("9.4: statementCount wird gezählt und der Trending-Score erhöht sich", async () => {
    await publishStatement(publishInput);

    // Zähler kommt aus der Tabelle (selbstheilend), nicht aus einem Inkrement.
    expect(txMock.statement.count).toHaveBeenCalledWith({
      where: { ticketId: "ticket-1", status: "PUBLISHED" },
    });

    const update = txMock.ticket.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, number>;
    };
    expect(update.where).toEqual({ id: "ticket-1" });
    expect(update.data.statementCount).toBe(3);
    // E = N + 2·S + 3·PPR: mehr Statements ⇒ höherer Trending-Score.
    expect(update.data.scoreTrending).toBeCloseTo(trending(14, 3, 1, 5), 3);
    expect(update.data.scoreTrending).toBeGreaterThan(trending(14, 2, 1, 5));
    // Votes bleiben unverändert — Consensus wird nur mitgeschrieben.
    expect(update.data.scoreConsensus).toBeCloseTo(wilsonLowerBound(10, 4), 12);
    expect(update.data.upvotes).toBeUndefined();
  });

  it("Ticket in der Transaktion nicht mehr publiziert: invalid_input", async () => {
    txMock.ticket.findUnique.mockResolvedValue({ status: "HIDDEN" });
    expect(await publishStatement(publishInput)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(txMock.statement.create).not.toHaveBeenCalled();
  });

  it("Doppel-Submit im Idempotenz-Fenster: bestehende Id, kein zweiter Insert", async () => {
    prismaMock.statement.findFirst.mockResolvedValue({ id: "statement-1" });
    expect(await publishStatement(publishInput)).toEqual({
      ok: true,
      statementId: "statement-1",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
