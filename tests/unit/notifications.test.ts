import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Benachrichtigungen (E14, 04.09.2026). Zwei Eigenschaften sind
 * sicherheits- bzw. korrektheitsrelevant:
 *
 * 1. Eigene Beiträge lösen NIE eine Benachrichtigung aus — sonst meldete die
 *    eigene Stimme «du hast eine Reaktion erhalten».
 * 2. Ohne Lesemarke (`null`) zählt alles bisher Passierte als ungelesen,
 *    statt dass ein neuer User nie etwas sieht.
 *
 * DB ist gemockt.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  ticket: { findMany: vi.fn() },
  ticketVote: { findFirst: vi.fn(), findMany: vi.fn() },
  statementVote: { findFirst: vi.fn(), findMany: vi.fn() },
  statement: { findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  changeRequest: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { hasUnreadNotifications, loadNotifications } from "@/lib/notifications";

const READ_AT = new Date("2026-09-01T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({
    notificationsReadAt: READ_AT,
  });
  prismaMock.ticketVote.findFirst.mockResolvedValue(null);
  prismaMock.statementVote.findFirst.mockResolvedValue(null);
  prismaMock.statement.findFirst.mockResolvedValue(null);
  prismaMock.changeRequest.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findMany.mockResolvedValue([
    { id: "t1", upvotes: 40, downvotes: 5 },
  ]);
  prismaMock.ticketVote.findMany.mockResolvedValue([]);
  prismaMock.statementVote.findMany.mockResolvedValue([]);
  prismaMock.statement.findMany.mockResolvedValue([]);
  prismaMock.changeRequest.findMany.mockResolvedValue([]);
  prismaMock.statement.groupBy.mockResolvedValue([]);
  prismaMock.changeRequest.count.mockResolvedValue(0);
});

describe("hasUnreadNotifications", () => {
  it("ohne Ereignisse: kein Punkt", async () => {
    expect(await hasUnreadNotifications("user-1")).toBe(false);
  });

  it.each([
    ["Vote auf mein Ticket", "ticketVote"],
    ["Vote auf mein Statement", "statementVote"],
    ["Statement auf mein Ticket", "statement"],
    ["Änderungsantrag auf mein Ticket", "changeRequest"],
  ])("%s löst den Punkt aus", async (_label, model) => {
    (
      prismaMock as unknown as Record<
        string,
        { findFirst: ReturnType<typeof vi.fn> }
      >
    )[model]!.findFirst.mockResolvedValue({ id: "x" });
    expect(await hasUnreadNotifications("user-1")).toBe(true);
  });

  it("schliesst eigene Beiträge aus", async () => {
    await hasUnreadNotifications("user-1");
    for (const call of [
      prismaMock.ticketVote.findFirst.mock.calls[0],
      prismaMock.statementVote.findFirst.mock.calls[0],
      prismaMock.statement.findFirst.mock.calls[0],
    ]) {
      const where = (call![0] as { where: Record<string, unknown> }).where;
      expect(where).toMatchObject(
        expect.objectContaining({
          ...("authorId" in where
            ? { authorId: { not: "user-1" } }
            : { userId: { not: "user-1" } }),
        }),
      );
    }
  });

  it("ohne Lesemarke zählt alles bisher Passierte", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      notificationsReadAt: null,
    });
    await hasUnreadNotifications("user-1");
    const where = prismaMock.ticketVote.findFirst.mock.calls[0]![0] as {
      where: { updatedAt: { gt: Date } };
    };
    expect(where.where.updatedAt.gt.getTime()).toBe(0);
  });

  it("unbekannter User: kein Punkt, keine weiteren Abfragen", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await hasUnreadNotifications("weg")).toBe(false);
    expect(prismaMock.ticketVote.findFirst).not.toHaveBeenCalled();
  });
});

describe("loadNotifications", () => {
  it("ohne Neuigkeiten bleibt alles leer", async () => {
    const result = await loadNotifications("user-1", "de");
    expect(result).toEqual({
      reactions: null,
      statements: null,
      changeRequests: null,
      tickets: [],
    });
  });

  it("zeigt den GESAMTSTAND der Reaktionen, nicht die Zuwächse", async () => {
    prismaMock.ticketVote.findMany.mockResolvedValue([{ ticketId: "t1" }]);
    prismaMock.statement.findMany.mockResolvedValue([]);
    prismaMock.ticket.findMany
      .mockResolvedValueOnce([{ id: "t1", upvotes: 40, downvotes: 5 }])
      .mockResolvedValueOnce([
        {
          id: "t1",
          translations: [
            { locale: "DE", title: "Mein Ticket", isOriginal: true },
          ],
        },
      ]);
    // Eigene Statements zählen mit (User-Entscheid: Reaktionen darauf auch).
    prismaMock.statement.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: "s1", upvotes: 2, downvotes: 1, ticketId: "t9" },
      ]);

    const result = await loadNotifications("user-1", "de");

    expect(result.reactions).toEqual({ up: 42, down: 6 });
    expect(result.statements).toBeNull();
    expect(result.changeRequests).toBeNull();
    expect(result.tickets).toEqual([{ id: "t1", title: "Mein Ticket" }]);
  });

  it("zählt Statements nach Kategorie und listet das Ticket", async () => {
    prismaMock.statement.findMany
      .mockResolvedValueOnce([{ ticketId: "t1" }])
      .mockResolvedValue([]);
    prismaMock.statement.groupBy.mockResolvedValue([
      { category: "PRO", _count: { _all: 3 } },
      { category: "FRAGE", _count: { _all: 1 } },
    ]);
    prismaMock.ticket.findMany
      .mockResolvedValueOnce([{ id: "t1", upvotes: 0, downvotes: 0 }])
      .mockResolvedValueOnce([
        {
          id: "t1",
          translations: [
            { locale: "DE", title: "Mein Ticket", isOriginal: true },
          ],
        },
      ]);

    const result = await loadNotifications("user-1", "de");

    expect(result.statements).toEqual({
      PRO: 3,
      CONTRA: 0,
      ERWEITERUNG: 0,
      FRAGE: 1,
    });
    expect(result.reactions).toBeNull();
    expect(result.tickets).toEqual([{ id: "t1", title: "Mein Ticket" }]);
  });

  it("zählt offene Änderungsanträge", async () => {
    prismaMock.changeRequest.findMany.mockResolvedValue([{ ticketId: "t1" }]);
    prismaMock.changeRequest.count.mockResolvedValue(2);
    prismaMock.ticket.findMany
      .mockResolvedValueOnce([{ id: "t1", upvotes: 0, downvotes: 0 }])
      .mockResolvedValueOnce([
        {
          id: "t1",
          translations: [
            { locale: "DE", title: "Mein Ticket", isOriginal: true },
          ],
        },
      ]);

    const result = await loadNotifications("user-1", "de");

    expect(result.changeRequests).toBe(2);
    expect(result.tickets).toHaveLength(1);
  });
});
