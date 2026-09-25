import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * DB-Integrationstests (Code-Review 25.09.2026) — brauchen die laufende
 * Compose-DB, ohne DATABASE_URL übersprungen. Laufen in CI im E2E-Job.
 *
 * 1. Parallele Votes verlieren keine Stimme mehr (lib/db-locks.ts): Ohne die
 *    Zeilensperre überschrieb unter READ COMMITTED eine Transaktion die
 *    Zählung der anderen.
 * 2. Das Hashtag-Autocomplete schlägt nur Tags publizierter Tickets vor.
 */

const currentUser = vi.hoisted(() => ({ id: "" }));

vi.mock("@/lib/require-user", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/require-user")>()),
  authenticatedUserId: async () => currentUser.id,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ ok: true }),
}));
vi.mock("next-auth", () => ({
  getServerSession: async () => ({
    user: { id: "test-conc-author", privacyConsent: true },
  }),
}));

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Nebenläufigkeit und Moderation gegen die echte DB", () => {
  const authorId = "test-conc-author";
  const ticketId = "test-conc-ticket";
  const hiddenTicketId = "test-conc-hidden";
  const voters = Array.from({ length: 8 }, (_, i) => `test-conc-voter-${i}`);

  let prisma: typeof import("@/lib/prisma").prisma;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    await prisma.user.createMany({
      data: [authorId, ...voters].map((id) => ({ id, handle: id })),
      skipDuplicates: true,
    });
    for (const [id, status, tag] of [
      [ticketId, "PUBLISHED", "testkonkurrenzsichtbar"],
      [hiddenTicketId, "DEPUBLISHED", "testkonkurrenzversteckt"],
    ] as const) {
      await prisma.ticket.upsert({
        where: { id },
        update: {},
        create: {
          id,
          authorId,
          level: "FEDERAL",
          originalLocale: "DE",
          status,
          hashtags: {
            connectOrCreate: [{ where: { tag }, create: { tag } }],
          },
        },
      });
    }
    await prisma.ticketVote.deleteMany({ where: { ticketId } });
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({
      where: { id: { in: [ticketId, hiddenTicketId] } },
    });
    await prisma.hashtag.deleteMany({
      where: {
        tag: { in: ["testkonkurrenzsichtbar", "testkonkurrenzversteckt"] },
      },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [authorId, ...voters] } },
    });
    await prisma.$disconnect();
  });

  it("acht gleichzeitige Upvotes ergeben exakt acht", async () => {
    const { voteOnTicket } = await import("@/actions/votes");
    // Jeder Aufruf liest die User-Id synchron beim Start — danach laufen alle
    // Transaktionen tatsächlich gleichzeitig.
    const results = await Promise.all(
      voters.map((id) => {
        currentUser.id = id;
        return voteOnTicket({ ticketId, value: "UP" });
      }),
    );
    expect(results.every((result) => result.ok)).toBe(true);

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { upvotes: true },
    });
    expect(ticket.upvotes).toBe(voters.length);
  });

  it("Autocomplete schlägt keine Tags depublizierter Tickets vor", async () => {
    const { GET } = await import("@/app/api/hashtags/suggest/route");
    const suggest = async (q: string) =>
      (
        (await (
          await GET(
            new NextRequest(`http://localhost/api/hashtags/suggest?q=${q}`),
          )
        ).json()) as { tags: string[] }
      ).tags;

    expect(await suggest("testkonkurrenzsicht")).toContain(
      "testkonkurrenzsichtbar",
    );
    expect(await suggest("testkonkurrenzversteckt")).not.toContain(
      "testkonkurrenzversteckt",
    );
  });
});
