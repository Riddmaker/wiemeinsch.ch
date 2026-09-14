import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

/**
 * DB-Integrationstests (T2) — brauchen die laufende Compose-DB.
 * Ohne DATABASE_URL (z.B. Host ohne DB-Zugang) werden sie übersprungen;
 * vollständig laufen sie im App-Container: `docker compose exec app npx vitest run`.
 */
describe.skipIf(!process.env.DATABASE_URL)("DB-Constraints", () => {
  const userId = "test-db-constraints-user";
  const ticketId = "test-db-constraints-ticket";

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, handle: "test-constraints" },
    });
    await prisma.ticket.upsert({
      where: { id: ticketId },
      update: {},
      create: {
        id: ticketId,
        authorId: userId,
        level: "FEDERAL",
        originalLocale: "DE",
      },
    });
    await prisma.ticketVote.deleteMany({ where: { ticketId } });
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { id: ticketId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("zweiter identischer TicketVote (User+Ticket) wirft Unique-Constraint-Fehler", async () => {
    await prisma.ticketVote.create({
      data: { userId, ticketId, value: "UP" },
    });

    await expect(
      prisma.ticketVote.create({ data: { userId, ticketId, value: "DOWN" } }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    );
  });

  it("öffentliche Projektion liefert keine Demografie-Werte aus der DB", async () => {
    const { publicUserSelect } = await import("@/lib/user-projection");
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: publicUserSelect,
    });
    const keys = Object.keys(user);
    for (const field of [
      "birthYear",
      "gender",
      "education",
      "postalCode",
      "occupation",
    ]) {
      expect(keys).not.toContain(field);
    }
  });
});
