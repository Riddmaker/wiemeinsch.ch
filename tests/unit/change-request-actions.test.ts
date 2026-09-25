import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-Action-Tests für den Political Pull Request (P10, T10-Bypass-Tests):
 * Reihenfolge Auth → Rate-Limit → Zod → Berechtigung → Linter, die
 * 200–3000-Zeichen-Grenze auch bei umgangenem Client, der Merge-Guard
 * (nur der Original-Autor entscheidet), die Stale-Basis und die
 * Trending-Neuberechnung mit Faktor 3 (E = N + 2·S + 3·PPR).
 * Seit E15 zusätzlich: 1:1-Übernahme aus der DB, «Anpassen & übernehmen» mit
 * serverseitig ermittelter Attribution, Rückgabe, Überarbeitung, Zurückziehen.
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
  // Zeilensperre (lib/db-locks.ts) — `SELECT … FOR UPDATE`.
  $queryRaw: vi.fn(),
  ticket: { findUnique: vi.fn(), update: vi.fn() },
  ticketTranslation: { updateMany: vi.fn() },
  changeRequest: {
    findUnique: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  changeRequestTranslation: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const prismaMock = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn() },
  ticketTranslation: { findUnique: vi.fn() },
  changeRequest: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  declineChangeRequest,
  mergeAdjustedChangeRequest,
  mergeChangeRequest,
  prepareAdjustedMerge,
  prepareChangeRequest,
  returnChangeRequest,
  submitChangeRequest,
  withdrawChangeRequest,
} from "@/actions/change-requests";
import { Prisma } from "@/generated/prisma/client";
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

/**
 * Aktueller Ticket-Inhalt in der Antragssprache. Seit E12 vergleicht die
 * Action jeden Antrag damit — ein Antrag, der nichts ändert, wird abgelehnt.
 * Der Text unterscheidet sich bewusst von `doc(400)`.
 */
const CURRENT_VERSION = {
  title: "Aktueller Titel",
  problem: doc(300),
  solution: {
    type: "doc" as const,
    content: [
      {
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: "y".repeat(400) }],
      },
    ],
  },
  funding: null,
};

const draft = {
  locale: "de" as const,
  ticketId: "ticket-1",
  solution: doc(400),
};

// E12: Fassungen sind jetzt Vorschlagsobjekte je Feld, nicht mehr ein
// blosses Lösungs-Dokument.
const submitInput = {
  ...draft,
  translations: { fr: { solution: doc(400) }, it: { solution: doc(400) } },
};

// E15: «Übernehmen» schickt nur die Id — der Text kommt aus der DB. Seit
// dem Review 25.09.2026 dazu der gesehene Revisionsstand (nie überarbeitet).
const mergeInput = { changeRequestId: "cr-1", revisedAt: null };

type StoredVersion = {
  title?: string;
  problem?: ConstrainedDoc;
  solution?: ConstrainedDoc;
  funding?: ConstrainedDoc;
};

/** Gespeicherter Antrag, wie ihn loadStoredVersions() liest. */
function storedRow(
  version: (locale: "DE" | "FR" | "IT") => StoredVersion,
  hashtags: string[] | null = null,
) {
  return {
    hashtags,
    translations: (["DE", "FR", "IT"] as const).map((locale) => {
      const v = version(locale);
      return {
        locale,
        title: v.title ?? null,
        problem: v.problem ?? null,
        solution: v.solution ?? null,
        funding: v.funding ?? null,
      };
    }),
  };
}

const STORED_SOLUTION = storedRow(() => ({ solution: doc(400) }));

/** Gespeicherter offener Antrag, wie ihn die Doppelklick-Prüfung liest. */
function openRowLike(input: {
  locale: "de" | "fr" | "it";
  title?: string;
  problem?: ConstrainedDoc;
  solution?: ConstrainedDoc;
  funding?: ConstrainedDoc;
  hashtags?: string[];
}) {
  return {
    id: "cr-1",
    originalLocale: input.locale.toUpperCase(),
    hashtags: input.hashtags ?? null,
    translations: [
      {
        title: input.title ?? null,
        problem: input.problem ?? null,
        solution: input.solution ?? null,
        funding: input.funding ?? null,
      },
    ],
  };
}

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
  prismaMock.ticketTranslation.findUnique.mockResolvedValue(CURRENT_VERSION);
  prismaMock.changeRequest.findFirst.mockResolvedValue(null);
  prismaMock.changeRequest.findUnique.mockResolvedValue(openChangeRequest);
  prismaMock.changeRequest.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: typeof txMock) => unknown) => fn(txMock),
  );
  txMock.ticket.findUnique.mockResolvedValue({
    status: "PUBLISHED",
    authorId: "author-9",
    contentRevision: 3,
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
  txMock.changeRequestTranslation.deleteMany.mockResolvedValue({ count: 3 });
  txMock.changeRequestTranslation.createMany.mockResolvedValue({ count: 3 });
  txMock.changeRequestTranslation.updateMany.mockResolvedValue({ count: 1 });
});

/**
 * Rolle «Ticket-Autor» für die Entscheid-Actions: user-1 IST der Autor, der
 * Antrag stammt von user-2. Die zweite findUnique-Abfrage (mit
 * `translations`) liefert die gespeicherten Fassungen.
 */
function asTicketAuthor(
  stored: ReturnType<typeof storedRow> = STORED_SOLUTION,
  status = "OPEN",
): void {
  const guard = {
    ...openChangeRequest,
    status,
    authorId: "user-2",
    ticket: { authorId: "user-1", status: "PUBLISHED" },
  };
  prismaMock.changeRequest.findUnique.mockImplementation(
    async (args: { select?: { translations?: unknown } }) =>
      args.select?.translations ? stored : guard,
  );
  txMock.changeRequest.findUnique.mockResolvedValue(guard);
}

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
      expect(plainText(result.translations.fr!.solution!)).toContain("FR: ");
      expect(plainText(result.translations.it!.solution!)).toContain("IT: ");
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
        baseContentRevision: number;
        translations: { create: { locale: string; isOriginal: boolean }[] };
      };
    };
    expect(created.data).toMatchObject({
      ticketId: "ticket-1",
      authorId: "user-1",
      originalLocale: "DE",
      // 10.4: Revisionsstand bei Antragstellung als Stale-Referenz.
      baseContentRevision: 3,
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

    // Zähler kommt aus der Tabelle (selbstheilend) — laufende (auch in
    // Überarbeitung, E15) und gemergte Anträge.
    expect(txMock.changeRequest.count).toHaveBeenCalledWith({
      where: {
        ticketId: "ticket-1",
        status: { in: ["OPEN", "CHANGES_REQUESTED", "MERGED"] },
        contentStatus: "PUBLISHED",
      },
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
      // … mit exakt demselben Original in allen Feldern ⇒ Doppelklick.
      .mockResolvedValueOnce(openRowLike(submitInput));
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

describe("mergeChangeRequest (P10.3, E15: 1:1) — nur der Original-Autor", () => {
  beforeEach(() => {
    asTicketAuthor();
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
    asTicketAuthor(STORED_SOLUTION, "MERGED");
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "not_open",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("E15: Antrag in Überarbeitung lässt sich nicht übernehmen", async () => {
    asTicketAuthor(STORED_SOLUTION, "CHANGES_REQUESTED");
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "awaiting_revision",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("E15: mitgeschickter Text wird vom Schema abgewiesen (keine getarnte Anpassung)", async () => {
    expect(
      await mergeChangeRequest({
        changeRequestId: "cr-1",
        locale: "de",
        versions: { de: { solution: doc(500) } },
      }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("gespeicherte Fassung fehlt (Datenfehler): invalid_input, keine Mutation", async () => {
    asTicketAuthor({
      hashtags: null,
      translations: STORED_SOLUTION.translations.slice(0, 2),
    });
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Happy Path: gespeicherte Fassungen in allen 3 Sprachen, Co-Autor, MERGED ohne Anpassung — ohne AI", async () => {
    expect(await mergeChangeRequest(mergeInput)).toEqual({ ok: true });

    // 1:1 kostet nichts: kein Linter, keine Übersetzung, kein AI-Budget.
    expect(lintFieldsMock).not.toHaveBeenCalled();
    expect(translateTextMock).not.toHaveBeenCalled();
    expect(checkAiBudgetMock).not.toHaveBeenCalled();

    const locales = txMock.ticketTranslation.updateMany.mock.calls.map(
      (call) => (call[0] as { where: { locale: string } }).where.locale,
    );
    expect(locales.sort()).toEqual(["DE", "FR", "IT"]);

    // `ticket.update` läuft mehrfach (Hashtags, Revision, Zähler-Refresh) —
    // gezielt den Revisions-/Co-Autor-Schritt suchen statt auf die
    // Aufrufreihenfolge zu wetten.
    const ticketUpdate = txMock.ticket.update.mock.calls
      .map((call) => call[0] as { data: Record<string, unknown> })
      .find((call) => "contentRevision" in call.data) as {
      data: {
        contentRevision: { increment: number };
        coAuthors: { connect: { id: string } };
      };
    };
    // 10.4: jede Inhaltsänderung erhöht die Revision (Stale-Basis).
    expect(ticketUpdate.data.contentRevision).toEqual({ increment: 1 });
    // Proof of Stake: der Antragsteller wird Co-Autor.
    expect(ticketUpdate.data.coAuthors).toEqual({ connect: { id: "user-2" } });

    // Atomar beansprucht, als 1:1-Übernahme markiert, keine merged*-Spalten.
    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cr-1",
        status: "OPEN",
        contentStatus: "PUBLISHED",
        revisedAt: null,
      },
      data: expect.objectContaining({
        status: "MERGED",
        mergedWithEdits: false,
      }),
    });
    expect(txMock.changeRequestTranslation.updateMany).not.toHaveBeenCalled();
  });

  it("Antrag in der Transaktion nicht mehr offen: invalid_input", async () => {
    txMock.changeRequest.findUnique.mockResolvedValue({
      ...openChangeRequest,
      status: "DECLINED",
      authorId: "user-2",
      ticket: { authorId: "user-1", status: "PUBLISHED" },
    });
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(txMock.ticketTranslation.updateMany).not.toHaveBeenCalled();
  });

  it("Wettlauf: Antrag wird zwischen Prüfung und Claim ersetzt ⇒ revised, kein Schreibzugriff aufs Ticket", async () => {
    // Der Claim verlangt den gesehenen Revisionsstand; eine Überarbeitung
    // dazwischen lässt ihn leer ausgehen, der Antrag ist aber noch offen.
    txMock.changeRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "revised",
    });
    expect(txMock.ticketTranslation.updateMany).not.toHaveBeenCalled();
    expect(txMock.ticket.update).not.toHaveBeenCalled();
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
        where: {
          id: "cr-1",
          status: { in: ["OPEN", "CHANGES_REQUESTED"] },
          contentStatus: "PUBLISHED",
        },
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

/**
 * E12 (04.09.2026): Ein Antrag darf jedes Inhaltsfeld betreffen — Titel,
 * Problem, Lösung, Finanzierung und Hashtags — und muss mindestens eines
 * ÄNDERN. Sicherheitsrelevant ist beides: dass nur die vorgeschlagenen
 * Felder gelintet und geschrieben werden (kein stiller Durchgriff auf
 * ungeprüften Text) und dass ein Antrag ohne Änderung gar nicht entsteht.
 */
describe("Änderungsanträge über alle Felder (E12)", () => {
  it("Antrag nur auf den Titel: lintet nur den Titel", async () => {
    const result = await prepareChangeRequest({
      locale: "de",
      ticketId: "ticket-1",
      title: "Ein deutlich besserer Titel",
    });

    expect(result.ok).toBe(true);
    expect(lintFieldsMock).toHaveBeenCalledTimes(1);
    expect(lintFieldsMock.mock.calls[0]![0]).toEqual({
      title: "Ein deutlich besserer Titel",
    });
  });

  it("Antrag nur auf die Hashtags: lintet nur die Hashtags", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({
      status: "PUBLISHED",
      authorId: "author-9",
      hashtags: [{ tag: "verkehr" }],
    });

    const result = await prepareChangeRequest({
      locale: "de",
      ticketId: "ticket-1",
      hashtags: ["verkehr", "sicherheit"],
    });

    expect(result.ok).toBe(true);
    expect(lintFieldsMock.mock.calls[0]![0]).toEqual({
      hashtags: "#verkehr #sicherheit",
    });
  });

  it("Antrag ohne jede Änderung: no_changes, kein Linter, keine Kosten", async () => {
    const result = await prepareChangeRequest({
      locale: "de",
      ticketId: "ticket-1",
      title: CURRENT_VERSION.title,
    });

    expect(result).toEqual({ ok: false, error: "no_changes" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
    expect(translateTextMock).not.toHaveBeenCalled();
  });

  it("Antrag ganz ohne Feld wird vom Schema abgewiesen", async () => {
    expect(
      await prepareChangeRequest({ locale: "de", ticketId: "ticket-1" }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Übersetzung mit abweichenden Feldern wird abgewiesen", async () => {
    // Original ändert den Titel, die FR-Fassung die Lösung — so käme
    // ungeprüfter Text in ein Feld, das der Antrag nie betraf.
    expect(
      await submitChangeRequest({
        locale: "de",
        ticketId: "ticket-1",
        title: "Neuer Titel",
        translations: {
          fr: { solution: doc(400) },
          it: { title: "Nouveau titre" },
        },
      }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Merge ersetzt NUR die vorgeschlagenen Felder", async () => {
    asTicketAuthor(storedRow((locale) => ({ title: `Neuer Titel ${locale}` })));
    expect(await mergeChangeRequest(mergeInput)).toEqual({ ok: true });

    const patches = txMock.ticketTranslation.updateMany.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
    expect(patches).toHaveLength(3);
    for (const patch of patches) {
      expect(Object.keys(patch)).toEqual(["title"]);
      expect(patch.solution).toBeUndefined();
    }
  });

  it("Merge mit Hashtags löst die alten und setzt die neuen", async () => {
    asTicketAuthor(storedRow(() => ({ solution: doc(400) }), ["velo"]));
    await mergeChangeRequest(mergeInput);

    const updates = txMock.ticket.update.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
    const hashtagUpdates = updates.filter((data) => "hashtags" in data);
    expect(hashtagUpdates).toHaveLength(2);
    expect(hashtagUpdates[0]!.hashtags).toEqual({ set: [] });
    expect(hashtagUpdates[1]!.hashtags).toEqual({
      connectOrCreate: [{ where: { tag: "velo" }, create: { tag: "velo" } }],
    });
  });
});

/**
 * E15 (14.09.2026): «Anpassen & übernehmen». Sicherheits- und
 * attributionsrelevant: Der Autor darf nur die Felder des Antrags anpassen,
 * und OB angepasst wurde, entscheidet der Server — nie der Client.
 */
describe("Anpassen & übernehmen (E15)", () => {
  const adjusted = {
    changeRequestId: "cr-1",
    revisedAt: null,
    locale: "de" as const,
    solution: doc(450),
  };
  const translations = {
    fr: { solution: doc(450) },
    it: { solution: doc(450) },
  };

  beforeEach(() => {
    asTicketAuthor();
  });

  it("prepare: lintet die Anpassung und übersetzt sie neu", async () => {
    const result = await prepareAdjustedMerge(adjusted);
    expect(result.ok).toBe(true);
    expect(lintFieldsMock).toHaveBeenCalledTimes(1);
    expect(translateTextMock).toHaveBeenCalled();
  });

  it("prepare ohne Änderung: no_changes, kein AI-Aufruf (dafür gibt es «Übernehmen»)", async () => {
    expect(
      await prepareAdjustedMerge({ ...adjusted, solution: doc(400) }),
    ).toEqual({ ok: false, error: "no_changes" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
    expect(translateTextMock).not.toHaveBeenCalled();
  });

  it("prepare mit einem Feld, das der Antrag nicht betrifft: invalid_input", async () => {
    expect(
      await prepareAdjustedMerge({ ...adjusted, title: "Anderer Titel" }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("prepare mit Hashtags, obwohl der Antrag sie nicht ändert: invalid_input", async () => {
    expect(
      await prepareAdjustedMerge({ ...adjusted, hashtags: ["velo"] }),
    ).toEqual({ ok: false, error: "invalid_input" });
  });

  it("fremder User: not_author, kein AI-Aufruf", async () => {
    requireUserMock.mockResolvedValue({ id: "user-9" });
    expect(await prepareAdjustedMerge(adjusted)).toEqual({
      ok: false,
      error: "not_author",
    });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("merge: angepasst ⇒ mergedWithEdits und die übernommene Fassung wird festgehalten", async () => {
    expect(
      await mergeAdjustedChangeRequest({ ...adjusted, translations }),
    ).toEqual({ ok: true });

    // Alle drei Fassungen sind Text des Autors und laufen durch den Linter.
    expect(lintFieldsMock).toHaveBeenCalledTimes(3);

    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cr-1",
        status: "OPEN",
        contentStatus: "PUBLISHED",
        revisedAt: null,
      },
      data: expect.objectContaining({
        status: "MERGED",
        mergedWithEdits: true,
      }),
    });
    const merged = txMock.changeRequestTranslation.updateMany.mock.calls.map(
      (call) =>
        call[0] as {
          where: { locale: string };
          data: Record<string, unknown>;
        },
    );
    expect(merged.map((call) => call.where.locale).sort()).toEqual([
      "DE",
      "FR",
      "IT",
    ]);
    for (const call of merged) {
      expect(Object.keys(call.data)).toEqual(["mergedSolution"]);
      expect(
        plainText(call.data.mergedSolution as ConstrainedDoc),
      ).toHaveLength(450);
    }
  });

  it("merge: identischer Text ⇒ KEINE Anpassung vermerkt (der Client kann sie nicht behaupten)", async () => {
    expect(
      await mergeAdjustedChangeRequest({
        ...adjusted,
        solution: doc(400),
        translations: {
          fr: { solution: doc(400) },
          it: { solution: doc(400) },
        },
      }),
    ).toEqual({ ok: true });
    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mergedWithEdits: false }),
      }),
    );
    expect(txMock.changeRequestTranslation.updateMany).not.toHaveBeenCalled();
  });

  it("merge: nur eine Übersetzung angepasst ⇒ gilt als Anpassung", async () => {
    await mergeAdjustedChangeRequest({
      ...adjusted,
      solution: doc(400),
      translations: {
        fr: { solution: doc(400) },
        it: { solution: doc(410) },
      },
    });
    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mergedWithEdits: true }),
      }),
    );
  });

  it("merge: Linter beanstandet eine Fassung ⇒ keine Mutation", async () => {
    const findings = [{ from: 0, to: 3, reason: "BELEIDIGUNG" as const }];
    lintFieldsMock.mockImplementation(async (_fields, textLocale: string) =>
      textLocale === "it" ? { solution: findings } : {},
    );
    expect(
      await mergeAdjustedChangeRequest({ ...adjusted, translations }),
    ).toEqual({
      ok: false,
      error: "linter",
      versions: { it: { solution: findings } },
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("merge: angepasste Hashtags werden als übernommene Hashtags festgehalten", async () => {
    asTicketAuthor(storedRow(() => ({ solution: doc(400) }), ["velo"]));
    await mergeAdjustedChangeRequest({
      ...adjusted,
      solution: doc(400),
      hashtags: ["velo", "sicherheit"],
      translations: {
        fr: { solution: doc(400) },
        it: { solution: doc(400) },
      },
    });
    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mergedWithEdits: true,
          mergedHashtags: ["velo", "sicherheit"],
        }),
      }),
    );
  });
});

describe("Zur Überarbeitung zurückgeben (E15)", () => {
  beforeEach(() => {
    asTicketAuthor();
  });

  it("setzt CHANGES_REQUESTED mit Grund und Zeitpunkt — atomar nur aus OPEN", async () => {
    expect(
      await returnChangeRequest({
        changeRequestId: "cr-1",
        revisedAt: null,
        reason: "FINANZIERUNG_UNKLAR",
      }),
    ).toEqual({ ok: true });
    expect(prismaMock.changeRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cr-1",
        status: "OPEN",
        contentStatus: "PUBLISHED",
        revisedAt: null,
      },
      data: {
        status: "CHANGES_REQUESTED",
        returnReason: "FINANZIERUNG_UNKLAR",
        returnedAt: expect.any(Date),
      },
    });
  });

  it("Grund ausserhalb des Katalogs (Freitext): invalid_input", async () => {
    expect(
      await returnChangeRequest({
        changeRequestId: "cr-1",
        revisedAt: null,
        reason: "Das ist Unsinn, du Idiot",
      }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.changeRequest.updateMany).not.toHaveBeenCalled();
  });

  it("fremder User: not_author", async () => {
    requireUserMock.mockResolvedValue({ id: "user-9" });
    expect(
      await returnChangeRequest({
        changeRequestId: "cr-1",
        revisedAt: null,
        reason: "ZU_UMFANGREICH",
      }),
    ).toEqual({ ok: false, error: "not_author" });
    expect(prismaMock.changeRequest.updateMany).not.toHaveBeenCalled();
  });

  it("bereits zurückgegeben: kein zweites Mal", async () => {
    asTicketAuthor(STORED_SOLUTION, "CHANGES_REQUESTED");
    expect(
      await returnChangeRequest({
        changeRequestId: "cr-1",
        revisedAt: null,
        reason: "ZU_UMFANGREICH",
      }),
    ).toEqual({ ok: false, error: "awaiting_revision" });
  });

  it("zurückgegebener Antrag lässt sich weiterhin ablehnen", async () => {
    asTicketAuthor(STORED_SOLUTION, "CHANGES_REQUESTED");
    expect(await declineChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: true,
    });
  });
});

describe("Antragsteller: überarbeiten und zurückziehen (E15)", () => {
  const ownRequest = {
    ticketId: "ticket-1",
    authorId: "user-1",
    status: "CHANGES_REQUESTED",
  };

  beforeEach(() => {
    // user-1 ist Antragsteller auf dem fremden Ticket von author-9.
    prismaMock.changeRequest.findUnique.mockResolvedValue(ownRequest);
  });

  it("prepare mit changeRequestId: kein duplicate_open für den eigenen Antrag", async () => {
    const result = await prepareChangeRequest({
      ...draft,
      changeRequestId: "cr-1",
    });
    expect(result.ok).toBe(true);
    expect(prismaMock.changeRequest.findFirst).not.toHaveBeenCalled();
  });

  it("submit mit changeRequestId: ersetzt den Antrag, setzt ihn auf OPEN und die Basis neu", async () => {
    expect(
      await submitChangeRequest({ ...submitInput, changeRequestId: "cr-1" }),
    ).toEqual({ ok: true, changeRequestId: "cr-1" });

    expect(txMock.changeRequest.create).not.toHaveBeenCalled();
    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cr-1",
        ticketId: "ticket-1",
        authorId: "user-1",
        status: { in: ["OPEN", "CHANGES_REQUESTED"] },
        contentStatus: "PUBLISHED",
      },
      data: expect.objectContaining({
        status: "OPEN",
        baseContentRevision: 3,
        returnReason: null,
        returnedAt: null,
        revisedAt: expect.any(Date),
      }),
    });
    expect(txMock.changeRequestTranslation.deleteMany).toHaveBeenCalledWith({
      where: { changeRequestId: "cr-1" },
    });
    const rows = (
      txMock.changeRequestTranslation.createMany.mock.calls[0]![0] as {
        data: { locale: string; changeRequestId: string }[];
      }
    ).data;
    expect(rows.map((row) => row.locale).sort()).toEqual(["DE", "FR", "IT"]);
    expect(rows.every((row) => row.changeRequestId === "cr-1")).toBe(true);
  });

  it("Überarbeitung eines fremden Antrags: not_requester, keine Mutation", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...ownRequest,
      authorId: "user-7",
    });
    expect(
      await submitChangeRequest({ ...submitInput, changeRequestId: "cr-1" }),
    ).toEqual({ ok: false, error: "not_requester" });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("Überarbeitung eines abgeschlossenen Antrags: not_open", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...ownRequest,
      status: "MERGED",
    });
    expect(
      await prepareChangeRequest({ ...draft, changeRequestId: "cr-1" }),
    ).toEqual({ ok: false, error: "not_open" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Wettlauf: Antrag wurde inzwischen übernommen ⇒ Claim scheitert, nichts ersetzt", async () => {
    txMock.changeRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await submitChangeRequest({ ...submitInput, changeRequestId: "cr-1" }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect(txMock.changeRequestTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("zurückziehen: WITHDRAWN, Zähler neu (zählt nicht mehr in E)", async () => {
    txMock.changeRequest.count.mockResolvedValue(0);
    expect(await withdrawChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: true,
    });
    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cr-1",
        authorId: "user-1",
        status: { in: ["OPEN", "CHANGES_REQUESTED"] },
        contentStatus: "PUBLISHED",
      },
      data: { status: "WITHDRAWN", decidedAt: expect.any(Date) },
    });
    const update = txMock.ticket.update.mock.calls[0]?.[0] as {
      data: Record<string, number>;
    };
    expect(update.data.changeRequestCount).toBe(0);
  });

  it("zurückziehen als Ticket-Autor oder fremder User: not_requester", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...ownRequest,
      authorId: "user-2",
    });
    expect(await withdrawChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: false,
      error: "not_requester",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("zurückziehen eines abgeschlossenen Antrags: not_open", async () => {
    prismaMock.changeRequest.findUnique.mockResolvedValue({
      ...ownRequest,
      status: "DECLINED",
    });
    expect(await withdrawChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: false,
      error: "not_open",
    });
  });

  it("neuer Antrag, während ein zurückgegebener läuft: duplicate_open", async () => {
    prismaMock.changeRequest.findFirst.mockResolvedValue({ id: "cr-1" });
    expect(await prepareChangeRequest(draft)).toEqual({
      ok: false,
      error: "duplicate_open",
    });
    const where = (
      prismaMock.changeRequest.findFirst.mock.calls[0]![0] as {
        where: { status: unknown };
      }
    ).where;
    expect(where.status).toEqual({ in: ["OPEN", "CHANGES_REQUESTED"] });
  });
});

/**
 * Code-Review 25.09.2026: Jeder Entscheid über den Inhalt ist an die Fassung
 * gebunden, die der Autor gesehen hat. Vorher übernahm «Übernehmen» den Text,
 * der im Moment des Klicks gespeichert war — auch einen, den der Antragsteller
 * erst nach dem Laden der Seite eingesetzt hatte.
 */
describe("Revisionsbindung der Entscheide (Review 25.09.2026)", () => {
  const REVISED = new Date("2026-09-25T08:00:00.000Z");

  function revisedAfterPageLoad(): void {
    const guard = {
      ...openChangeRequest,
      authorId: "user-2",
      revisedAt: REVISED,
      ticket: { authorId: "user-1", status: "PUBLISHED" },
    };
    prismaMock.changeRequest.findUnique.mockImplementation(
      async (args: { select?: { translations?: unknown } }) =>
        args.select?.translations ? STORED_SOLUTION : guard,
    );
    txMock.changeRequest.findUnique.mockResolvedValue(guard);
  }

  it("Übernehmen einer inzwischen überarbeiteten Fassung: revised, keine Mutation", async () => {
    revisedAfterPageLoad();
    expect(await mergeChangeRequest(mergeInput)).toEqual({
      ok: false,
      error: "revised",
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("mit dem gesehenen Stand geht der Merge durch — und der Claim verlangt ihn", async () => {
    revisedAfterPageLoad();
    expect(
      await mergeChangeRequest({
        changeRequestId: "cr-1",
        revisedAt: REVISED.toISOString(),
      }),
    ).toEqual({ ok: true });
    expect(txMock.changeRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "cr-1",
          status: "OPEN",
          contentStatus: "PUBLISHED",
          revisedAt: REVISED,
        },
      }),
    );
  });

  it("Anpassen vorbereiten auf überarbeitetem Antrag: revised, kein AI-Aufruf", async () => {
    revisedAfterPageLoad();
    expect(
      await prepareAdjustedMerge({
        changeRequestId: "cr-1",
        revisedAt: null,
        locale: "de",
        solution: doc(450),
      }),
    ).toEqual({ ok: false, error: "revised" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
    expect(translateTextMock).not.toHaveBeenCalled();
  });

  it("Zurückgeben bezieht sich auf die gesehene Fassung: revised", async () => {
    revisedAfterPageLoad();
    expect(
      await returnChangeRequest({
        changeRequestId: "cr-1",
        revisedAt: null,
        reason: "ZU_WENIG_KONKRET",
      }),
    ).toEqual({ ok: false, error: "revised" });
    expect(prismaMock.changeRequest.updateMany).not.toHaveBeenCalled();
  });

  it("ohne Revisionsstand weist das Schema den Entscheid ab", async () => {
    asTicketAuthor();
    expect(await mergeChangeRequest({ changeRequestId: "cr-1" })).toEqual({
      ok: false,
      error: "invalid_input",
    });
  });
});

describe("Doppelklick-Erkennung vergleicht alle Felder (Review 25.09.2026)", () => {
  it("offener Antrag mit gleicher Lösung, aber anderer Finanzierung: duplicate_open", async () => {
    prismaMock.changeRequest.findFirst
      .mockResolvedValueOnce({ id: "cr-1" })
      .mockResolvedValueOnce(openRowLike({ ...submitInput, funding: doc(50) }));
    expect(await submitChangeRequest(submitInput)).toEqual({
      ok: false,
      error: "duplicate_open",
    });
  });

  it("offener Antrag mit anderen Hashtags: duplicate_open", async () => {
    prismaMock.changeRequest.findFirst
      .mockResolvedValueOnce({ id: "cr-1" })
      .mockResolvedValueOnce(
        openRowLike({ ...submitInput, hashtags: ["velo"] }),
      );
    expect(await submitChangeRequest(submitInput)).toEqual({
      ok: false,
      error: "duplicate_open",
    });
  });
});

describe("Finanzierung entfernen (Review 25.09.2026)", () => {
  const emptyDoc: ConstrainedDoc = {
    type: "doc",
    content: [{ type: "paragraph" }],
  };

  it("leere Finanzierung wird ohne LLM-Aufruf in die anderen Sprachen übernommen", async () => {
    prismaMock.ticketTranslation.findUnique.mockResolvedValue({
      ...CURRENT_VERSION,
      funding: doc(100),
    });
    const result = await prepareChangeRequest({
      locale: "de",
      ticketId: "ticket-1",
      funding: emptyDoc,
    });
    expect(result).toEqual({
      ok: true,
      translations: { fr: { funding: emptyDoc }, it: { funding: emptyDoc } },
    });
    expect(translateTextMock).not.toHaveBeenCalled();
  });

  it("leere Finanzierung auf einem Ticket ohne Finanzierung ändert nichts", async () => {
    expect(
      await prepareChangeRequest({
        locale: "de",
        ticketId: "ticket-1",
        funding: emptyDoc,
      }),
    ).toEqual({ ok: false, error: "no_changes" });
  });

  it("Merge setzt die Finanzierung am Ticket auf NULL statt auf ein leeres Dokument", async () => {
    asTicketAuthor(storedRow(() => ({ funding: emptyDoc })));
    expect(await mergeChangeRequest(mergeInput)).toEqual({ ok: true });
    const patches = txMock.ticketTranslation.updateMany.mock.calls.map(
      (call) => (call[0] as { data: { funding?: unknown } }).data.funding,
    );
    expect(patches).toHaveLength(3);
    for (const funding of patches) {
      expect(funding).toBe(Prisma.DbNull);
    }
  });
});
