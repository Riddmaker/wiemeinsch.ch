import { describe, expect, it, vi } from "vitest";

/**
 * Anzeige der Änderungsanträge (Review 25.09.2026): Depublizierte Anträge
 * verschwinden, die laufende Nummer der übrigen bleibt stabil — die
 * Co-Autor-Zeile verweist auf «#N».
 */

const findManyMock = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    changeRequest: { findMany: (args: unknown) => findManyMock(args) },
  },
}));

const { loadChangeRequests } = await import("@/lib/change-requests");

function row(id: string, contentStatus: "PUBLISHED" | "DEPUBLISHED") {
  return {
    id,
    status: "DECLINED",
    contentStatus,
    authorId: `author-${id}`,
    author: { handle: `h_${id}` },
    originalLocale: "DE",
    baseContentRevision: 0,
    hashtags: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    decidedAt: null,
    returnReason: null,
    returnedAt: null,
    revisedAt: null,
    mergedWithEdits: false,
    mergedHashtags: null,
    translations: [
      {
        locale: "DE",
        isOriginal: true,
        title: `Titel ${id}`,
        problem: null,
        solution: null,
        funding: null,
        mergedTitle: null,
        mergedProblem: null,
        mergedSolution: null,
        mergedFunding: null,
      },
    ],
  };
}

describe("loadChangeRequests", () => {
  it("blendet depublizierte Anträge aus, ohne die Nummern zu verschieben", async () => {
    findManyMock.mockResolvedValue([
      row("a", "PUBLISHED"),
      row("b", "DEPUBLISHED"),
      row("c", "PUBLISHED"),
    ]);
    const entries = await loadChangeRequests({
      ticketId: "t1",
      contentRevision: 0,
      displayLocale: "de",
      viewerId: null,
      isTicketAuthor: false,
    });
    expect(entries.map((entry) => [entry.id, entry.number])).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
  });
});
