import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-Action-Tests für den Political Pull Request (P10, T10-Bypass-Tests):
 * Reihenfolge Auth → Rate-Limit → Zod → Berechtigung → Linter, die
 * 200–3000-Zeichen-Grenze auch bei umgangenem Client, der Merge-Guard
 * (nur der Original-Autor entscheidet), die Stale-Basis und die
 * Trending-Neuberechnung mit Faktor 3 (E = N + 2·S + 3·PPR).
 * DB und AI sind gemockt.
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
  ticketTranslation: { updateMany: vi.fn() },
  changeRequest: {
    findUnique: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const prismaMock = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn() },
  changeRequest: { findFirst: vi.fn(), findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  declineChangeRequest,
  mergeChangeRequest,
  prepareChangeRequest,
  submitChangeRequest,
} from "@/actions/change-requests";
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
  solution: doc(400),
};

const submitInput = {
  ...draft,
  translations: { fr: doc(400), it: doc(400) },
};

const mergeInput = {
  changeRequestId: "cr-1",
  locale: "de" as const,
  versions: { de: doc(400), fr: doc(400), it: doc(400) },
};

/** Antrag auf einem fremden Ticket, offen, Autor des Tickets ist user-2. */
const openChangeRequest = {
  status: "OPEN",
  authorId: "user-1",
  ticketId: "ticket-1",
  ticket: { authorId: "user-2", status: "PUBLISHED" },
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
  // Fremdes, publiziertes Ticket ohne offenen Antrag desselben Users.
  prismaMock.ticket.findUnique.mockResolvedValue({
    status: "PUBLISHED",
    authorId: "author-9",
  });
  prismaMock.changeRequest.findFirst.mockResolvedValue(null);
  prismaMock.changeRequest.findUnique.mockResolvedValue(openChangeRequest);
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof txMock) => unknown) => fn(txMock),
  );
  txMock.ticket.findUnique.mockResolvedValue({
    status: "PUBLISHED",
    authorId: "author-9",
    solutionRevision: 3,
    upvotes: 10,
    downvotes: 4,
    statementCount: 2,
    createdAt: TICKET_CREATED_AT,
  });
  txMock.changeRequest.findUnique.mockResolvedValue(openChangeRequest);
  txMock.changeRequest.create.mockResolvedValue({ id: "cr-1" });
  // Zwei verschiedene count-Abfragen: Race-Check (offener Antrag desselben
  // Users) vs. Neuzaehlung fuer den Trending-Score.
  txMock.changeRequest.count.mockImplementation(
    async (args: { where?: { authorId?: string } }) =>
      args.where?.authorId ? 0 : 1,
  );
  txMock.changeRequest.updateMany.mockResolvedValue({ count: 1 });
});

describe("prepareChangeRequest (P10.1) — Reihenfolge & Bypass-Schutz", () => {
  it("ohne Session: unauthorized, kein Linter-/DB-Zugriff", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
    expect(prismaMock.ticket.findUnique).not.toHaveBeenCalled();
  });

  it("Rate-Limit greift VOR Zod und Linter", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Server-Bypass 199 bzw. 3001 Zeichen: invalid_input ohne Linter-Call", async () => {
    expect(
      await prepareChangeRequest({ ...draft, solution: doc(199) }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(
      await prepareChangeRequest({ ...draft, solution: doc(3001) }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("200 Zeichen sind gültig (Grenze inklusiv)", async () => {
    const result = await prepareChangeRequest({ ...draft, solution: doc(200) });
    expect(result.ok).toBe(true);
  });

  it("10.5: eigener Antrag auf eigenes Ticket wird blockiert", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({
      status: "PUBLISHED",
      authorId: "user-1",
    });
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "own_ticket",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("zweiter offener Antrag desselben Users: duplicate_open", async () => {
    prismaMock.changeRequest.findFirst.mockResolvedValue({ id: "cr-0" });
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "duplicate_open",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("unbekanntes oder nicht publiziertes Ticket: invalid_input", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "invalid_input",
    });

    prismaMock.ticket.findUnique.mockResolvedValue({
      status: "HIDDEN",
      authorId: "author-9",
    });
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Linter-Blockade: Findings zurück, KEINE Übersetzung", async () => {
    const findings = [{ from: 0, to: 5, reason: "POLEMIK" as const }];
    lintFieldsMock.mockResolvedValue({ solution: findings });
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "linter",
      fields: { solution: findings },
    });
    expect(translateTextMock).not.toHaveBeenCalled();
  });

  it("Happy Path: lintet den Vorschlag, liefert FR+IT-Preview", async () => {
    const result = await prepareChangeRequest(draft);

    expect(lintFieldsMock).toHaveBeenCalledTimes(1);
    const [fields, textLocale, userLocale] = lintFieldsMock.mock.calls[0]!;
    expect(fields).toEqual({ solution: plainText(draft.solution) });
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
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "ai_unavailable",
    });
  });
});

describe("submitChangeRequest (P10.1/10.4/10.5)", () => {
  it("ohne Session: unauthorized, keine DB-Mutation", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    expect(await submitChangeRequest(submitInput)).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("fehlende Übersetzung: invalid_input ohne Linter-Call", async () => {
    expect(
      await submitChangeRequest({ ...draft, translations: { fr: doc(400) } }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Server-Bypass in einer Übersetzung (199 Zeichen): invalid_input", async () => {
    expect(
      await submitChangeRequest({
        ...submitInput,
        translations: { fr: doc(199), it: doc(400) },
      }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("eigenes Ticket: own_ticket, keine DB-Mutation (T10)", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({
      status: "PUBLISHED",
      authorId: "user-1",
    });
    expect(await submitChangeRequest(submitInput)).toEqual({
      ok: false,
      error: "own_ticket",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("lintet ALLE drei Fassungen und speichert sie mit Stale-Basis", async () => {
    const result = await submitChangeRequest(submitInput);

    expect(lintFieldsMock).toHaveBeenCalledTimes(3);
    expect(
      lintFieldsMock.mock.calls.map(([, textLocale]) => textLocale),
    ).toEqual(expect.arrayContaining(["de", "fr", "it"]));

    const created = txMock.changeRequest.create.mock.calls[0]?.[0] as {
      data: {
        ticketId: string;
        authorId: string;
        originalLocale: string;
        baseSolutionRevision: number;
        translations: { create: { locale: string; isOriginal: boolean }[] };
      };
    };
    expect(created.data).toMatchObject({
      ticketId: "ticket-1",
      authorId: "user-1",
      originalLocale: "DE",
      // 10.4: Revisionsstand bei Antragstellung als Stale-Referenz.
      baseSolutionRevision: 3,
    });
    const rows = created.data.translations.create;
    expect(rows.map((row) => row.locale).sort()).toEqual(["DE", "FR", "IT"]);
    expect(rows.filter((row) => row.isOriginal)).toHaveLength(1);
    expect(result).toEqual({ ok: true, changeRequestId: "cr-1" });
  });

  it("Linter beanstandet eine Übersetzung: versions zurück, keine Mutation", async () => {
    const findings = [{ from: 0, to: 4, reason: "RAGEBAIT" as const }];
    lintFieldsMock.mockImplementation(async (_fields, textLocale: string) =>
      textLocale === "fr" ? { solution: findings } : {},
    );
    expect(await submitChangeRequest(submitInput)).toEqual({
      ok: false,
      error: "linter",
      versions: { fr: { solution: findings } },
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("10.5: changeRequestCount wird gezählt, PPR wiegt 3× einen Vote", async () => {
    await submitChangeRequest(submitInput);

    // Zähler kommt aus der Tabelle (selbstheilend) — nur OPEN + MERGED.
    expect(txMock.changeRequest.count).toHaveBeenCalledWith({
      where: { ticketId: "ticket-1", status: { in: ["OPEN", "MERGED"] } },
    });

    const update = txMock.ticket.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, number>;
    };
    expect(update.where).toEqual({ id: "ticket-1" });
    expect(update.data.changeRequestCount).toBe(1);
    // E = N + 2·S + 3·PPR bei N=14, S=2, PPR=1, t=5 h.
    expect(update.data.scoreTrending).toBeCloseTo(trending(14, 2, 1, 5), 3);
    // Ein Antrag hebt E um 3, ein zusätzlicher Vote nur um 1.
    expect(update.data.scoreTrending).toBeCloseTo(trending(14 + 3, 2, 0, 5), 3);
    expect(update.data.scoreTrending).toBeGreaterThan(trending(15, 2, 0, 5));
    // Votes bleiben unverändert — Consensus wird nur mitgeschrieben.
    expect(update.data.scoreConsensus).toBeCloseTo(wilsonLowerBound(10, 4), 12);
    expect(update.data.upvotes).toBeUndefined();
  });

  it("Doppel-Submit mit identischem Text: bestehende Id, kein zweiter Insert", async () => {
    prismaMock.changeRequest.findFirst
      // Guard-Abfrage: es existiert bereits ein offener Antrag …
      .mockResolvedValueOnce({ id: "cr-1" })
      // … mit exakt demselben Originaltext ⇒ Doppelklick.
      .mockResolvedValueOnce({ id: "cr-1" });
    expect(await submitChangeRequest(submitInput)).toEqual({
      ok: true,
      changeRequestId: "cr-1",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("offener Antrag mit anderem Text: duplicate_open statt zweiter Antrag", async () => {
    prismaMock.changeRequest.findFirst
      .mockResolvedValueOnce({ id: "cr-0" })
      .mockResolvedValueOnce(null);
    expect(await submitChangeRequest(submitInput)).toEqual({
      ok: false,
      error: "duplicate_open",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe("mergeChangeRequest (P10.3) — nur der Original-Autor", () => {
  beforeEach(() => {
    // Standardrolle in diesem Block: user-1 IST der Ticket-Autor.
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...openChangeRequest,
      authorId: "user-2",
      ticket: { authorId: "user-1", status: "PUBLISHED" },
    });
    txMock.changeRequest.findUnique.mockResolvedValue({
      ...openChangeRequest,
      authorId: "user-2",
      ticket: { authorId: "user-1", status: "PUBLISHED" },
    });
  });

  it("T10-Bypass: fremder User ruft Merge auf ⇒ not_author, keine Mutation", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...openChangeRequest,
      ticket: { authorId: "someone-else", status: "PUBLISHED" },
    });
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "not_author",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("ohne Session: unauthorized, keine Mutation", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("bereits entschiedener Antrag: not_open", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...openChangeRequest,
      status: "MERGED",
      ticket: { authorId: "user-1", status: "PUBLISHED" },
    });
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "not_open",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("fehlende Sprachfassung: invalid_input ohne Linter-Call", async () => {
    expect(
      await mergeChangeRequest({
        ...mergeInput,
        versions: { de: doc(400), fr: doc(400) },
      }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("editierte Fassung wird beanstandet: linter, keine Mutation", async () => {
    const findings = [{ from: 0, to: 3, reason: "BELEIDIGUNG" as const }];
    lintFieldsMock.mockImplementation(async (_fields, textLocale: string) =>
      textLocale === "it" ? { solution: findings } : {},
    );
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "linter",
      versions: { it: { solution: findings } },
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Happy Path: Lösung in allen 3 Sprachen ersetzt, Co-Autor, MERGED", async () => {
    expect(await mergeChangeRequest(mergeInput)).toEqual({ ok: true });

    // Alle drei Fassungen erneut gelintet (Autor darf editieren).
    expect(lintFieldsMock).toHaveBeenCalledTimes(3);

    const locales = txMock.ticketTranslation.updateMany.mock.calls.map(
      (call) => (call[0] as { where: { locale: string } }).where.locale,
    );
    expect(locales.sort()).toEqual(["DE", "FR", "IT"]);

    const ticketUpdate = txMock.ticket.update.mock.calls[0]?.[0] as {
      data: {
        solutionRevision: { increment: number };
        coAuthors: { connect: { id: string } };
      };
    };
    // 10.4: jede Lösungsänderung erhöht die Revision (Stale-Basis).
    expect(ticketUpdate.data.solutionRevision).toEqual({ increment: 1 });
    // Proof of Stake: der Antragsteller wird Co-Autor.
    expect(ticketUpdate.data.coAuthors).toEqual({ connect: { id: "user-2" } });

    expect(txMock.changeRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cr-1" },
        data: expect.objectContaining({ status: "MERGED" }),
      }),
    );
  });

  it("Antrag in der Transaktion nicht mehr offen: invalid_input", async () => {
    txMock.changeRequest.findUnique.mockResolvedValue({
      ...openChangeRequest,
      status: "DECLINED",
      ticket: { authorId: "user-1", status: "PUBLISHED" },
    });
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(txMock.ticketTranslation.updateMany).not.toHaveBeenCalled();
  });
});

describe("declineChangeRequest (P10.3)", () => {
  beforeEach(() => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...openChangeRequest,
      authorId: "user-2",
      ticket: { authorId: "user-1", status: "PUBLISHED" },
    });
  });

  it("ohne Session: unauthorized, keine Mutation", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    expect(await declineChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("fremder User: not_author, keine Mutation", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...openChangeRequest,
      ticket: { authorId: "someone-else", status: "PUBLISHED" },
    });
    expect(await declineChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: false,
      error: "not_author",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Autor lehnt ab: DECLINED, Lösungstext unberührt, Score sinkt zurück", async () => {
    txMock.changeRequest.count.mockImplementation(async () => 0);
    expect(await declineChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: true,
    });

    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cr-1", status: "OPEN" },
        data: expect.objectContaining({ status: "DECLINED" }),
      }),
    );
    // Lösung bleibt, wie sie ist.
    expect(txMock.ticketTranslation.updateMany).not.toHaveBeenCalled();

    const update = txMock.ticket.update.mock.calls[0]?.[0] as {
      data: Record<string, number>;
    };
    expect(update.data.changeRequestCount).toBe(0);
    expect(update.data.scoreTrending).toBeCloseTo(trending(14, 2, 0, 5), 3);
  });

  it("Antrag zwischenzeitlich entschieden: not_open", async () => {
    txMock.changeRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(await declineChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: false,
      error: "not_open",
    });
  });
});
