import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-Action-Tests für den Ticket-Publish-Flow (P7.3/P7.5, T7 Bypass-Tests):
 * Auth/Rate-Limit/Zod/Linter-Reihenfolge, Fail-closed (E8), Idempotenz und
 * die transaktionale Persistenz aller drei Sprachfassungen. Services und DB
 * sind gemockt — die echten Fehlerklassen bleiben erhalten.
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

// Objekt-Literal muss über vi.hoisted vor die gehoisteten vi.mock-Calls.
const prismaMock = vi.hoisted(() => ({
  canton: { findUnique: vi.fn() },
  municipality: { findUnique: vi.fn() },
  ticket: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { prepareTicketPublish, publishTicket } from "@/actions/tickets";
import { UnauthorizedError } from "@/lib/require-user";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";
import { plainText } from "@/lib/validation/tiptap";
import { MistralUnavailableError } from "@/services/mistral";

const richDoc = (chars: number): ConstrainedDoc => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "x".repeat(chars) }] },
  ],
});

const emptyDoc: ConstrainedDoc = { type: "doc", content: [] };

const draft = {
  locale: "de" as const,
  level: "FEDERAL" as const,
  cantonId: null,
  municipalityId: null,
  title: "Tempo 30 auf Quartierstrassen einheitlich regeln",
  hashtags: ["verkehr"],
  problem: richDoc(250),
  solution: richDoc(250),
  funding: emptyDoc,
};

const translatedVersion = {
  title: "Titre traduit",
  problem: richDoc(250),
  solution: richDoc(250),
};

const publishInput = {
  ...draft,
  translations: { fr: translatedVersion, it: translatedVersion },
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
  prismaMock.canton.findUnique.mockResolvedValue({ id: 1 });
  prismaMock.municipality.findUnique.mockResolvedValue({ id: 261 });
  prismaMock.ticket.findFirst.mockResolvedValue(null);
  prismaMock.ticket.create.mockResolvedValue({ id: "ticket-1" });
});

describe("prepareTicketPublish (P7.3)", () => {
  it("ohne Session: unauthorized, kein Linter-/DB-Zugriff", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    const result = await prepareTicketPublish(draft);
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Rate-Limit greift VOR Zod und Linter", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });
    const result = await prepareTicketPublish(draft);
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Server-Bypass: 3001-Zeichen-Problem → invalid_input ohne Linter-Call", async () => {
    const result = await prepareTicketPublish({
      ...draft,
      problem: richDoc(3001),
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("unbekannter Kanton → invalid_input (Fremd-IDs sind kein Bypass)", async () => {
    prismaMock.canton.findUnique.mockResolvedValue(null);
    const result = await prepareTicketPublish({
      ...draft,
      level: "CANTONAL",
      cantonId: 99,
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("Linter-Blockade: Findings pro Feld zurück, KEINE Übersetzung", async () => {
    const findings = [{ from: 0, to: 5, reason: "POLEMIK" as const }];
    lintFieldsMock.mockResolvedValue({ problem: findings });
    const result = await prepareTicketPublish(draft);
    expect(result).toEqual({
      ok: false,
      error: "linter",
      fields: { problem: findings },
    });
    expect(translateTextMock).not.toHaveBeenCalled();
  });

  it("Happy Path: lintet alle Felder inkl. Hashtags, liefert FR+IT-Preview", async () => {
    const result = await prepareTicketPublish(draft);
    expect(lintFieldsMock).toHaveBeenCalledTimes(1);
    const [fields, textLocale, userLocale] = lintFieldsMock.mock.calls[0]!;
    expect(textLocale).toBe("de");
    expect(userLocale).toBe("de");
    expect(fields).toMatchObject({
      title: draft.title,
      hashtags: "#verkehr",
    });
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(["title", "problem", "solution", "hashtags"]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.translations.fr?.title).toBe(`FR: ${draft.title}`);
      expect(result.translations.it?.title).toBe(`IT: ${draft.title}`);
      expect(plainText(result.translations.fr?.problem)).toContain("FR: ");
      // leere Finanzierung wird nicht übersetzt
      expect(result.translations.fr?.funding).toBeUndefined();
    }
  });

  it("Mistral-Ausfall → ai_unavailable (E8 fail-closed)", async () => {
    lintFieldsMock.mockRejectedValue(new MistralUnavailableError("down"));
    const result = await prepareTicketPublish(draft);
    expect(result).toEqual({ ok: false, error: "ai_unavailable" });
  });
});

describe("publishTicket (P7.5)", () => {
  it("ohne Session: unauthorized, keine DB-Mutation", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    const result = await publishTicket(publishInput);
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
  });

  it("fehlende Übersetzung → invalid_input", async () => {
    const result = await publishTicket({
      ...draft,
      translations: { fr: translatedVersion },
    });
    expect(result).toEqual({ ok: false, error: "invalid_input" });
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
  });

  it("Idempotenz: identischer Titel im Zeitfenster → bestehende ID, kein Duplikat", async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: "existing-1" });
    const result = await publishTicket(publishInput);
    expect(result).toEqual({ ok: true, ticketId: "existing-1" });
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
    expect(lintFieldsMock).not.toHaveBeenCalled();
  });

  it("lintet ALLE drei Fassungen (auch unveränderte Übersetzungen)", async () => {
    await publishTicket(publishInput);
    expect(lintFieldsMock).toHaveBeenCalledTimes(3);
    const locales = lintFieldsMock.mock.calls.map(
      ([, textLocale]) => textLocale,
    );
    expect(locales).toEqual(expect.arrayContaining(["de", "fr", "it"]));
    // Begründungen immer in der Sprache des Autors
    for (const [, , userLocale] of lintFieldsMock.mock.calls) {
      expect(userLocale).toBe("de");
    }
    // Hashtags nur in der Original-Fassung (werden nicht übersetzt)
    const deCall = lintFieldsMock.mock.calls.find(
      ([, textLocale]) => textLocale === "de",
    )!;
    const frCall = lintFieldsMock.mock.calls.find(
      ([, textLocale]) => textLocale === "fr",
    )!;
    expect(deCall[0]).toHaveProperty("hashtags");
    expect(frCall[0]).not.toHaveProperty("hashtags");
  });

  it("Blockade in einer Übersetzung → versions.fr, keine DB-Zeile", async () => {
    const findings = [{ from: 0, to: 4, reason: "BELEIDIGUNG" as const }];
    lintFieldsMock.mockImplementation(async (_fields, textLocale) =>
      textLocale === "fr" ? { solution: findings } : {},
    );
    const result = await publishTicket(publishInput);
    expect(result).toEqual({
      ok: false,
      error: "linter",
      versions: { fr: { solution: findings } },
    });
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
  });

  it("Happy Path: EIN nested create mit 3 Sprachzeilen + Hashtags", async () => {
    const result = await publishTicket(publishInput);
    expect(result).toEqual({ ok: true, ticketId: "ticket-1" });
    expect(prismaMock.ticket.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.ticket.create.mock.calls[0]![0].data;
    expect(data.originalLocale).toBe("DE");
    expect(data.hashtags.connectOrCreate).toEqual([
      { where: { tag: "verkehr" }, create: { tag: "verkehr" } },
    ]);
    const rows = data.translations.create;
    expect(rows).toHaveLength(3);
    expect(
      rows.filter((row: { isOriginal: boolean }) => row.isOriginal),
    ).toHaveLength(1);
    expect(rows.map((row: { locale: string }) => row.locale).sort()).toEqual([
      "DE",
      "FR",
      "IT",
    ]);
    // leere Finanzierung wird als NULL gespeichert (Feld fehlt im Insert)
    for (const row of rows) {
      expect(row).not.toHaveProperty("funding");
    }
  });

  it("Mistral-Ausfall beim Publish → ai_unavailable, keine DB-Zeile", async () => {
    lintFieldsMock.mockRejectedValue(new MistralUnavailableError("down"));
    const result = await publishTicket(publishInput);
    expect(result).toEqual({ ok: false, error: "ai_unavailable" });
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
  });
});
