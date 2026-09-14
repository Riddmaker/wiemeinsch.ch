import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Admin-Guard (P12.3): `isAdmin` kommt IMMER frisch aus der Datenbank und nie
 * aus dem Session-Objekt — ein manipuliertes Token bringt niemanden in die
 * Moderations-Queue, und ein entzogenes Recht wirkt sofort.
 */

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { getServerSession } from "next-auth";
import { adminUserId } from "@/lib/require-admin";

const mockedSession = vi.mocked(getServerSession);

describe("adminUserId (T12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ohne Session: null, ohne DB-Abfrage", async () => {
    mockedSession.mockResolvedValue(null);
    expect(await adminUserId()).toBeNull();
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("eingeloggt ohne Admin-Flag: null", async () => {
    mockedSession.mockResolvedValue({ user: { id: "user-1" } });
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: false });
    expect(await adminUserId()).toBeNull();
  });

  it("isAdmin im Session-Objekt zählt NICHT — die DB entscheidet", async () => {
    mockedSession.mockResolvedValue({
      user: { id: "user-1", isAdmin: true },
    });
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: false });
    expect(await adminUserId()).toBeNull();
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { isAdmin: true },
    });
  });

  it("gelöschter User trotz gültiger Session: null", async () => {
    mockedSession.mockResolvedValue({ user: { id: "ghost" } });
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await adminUserId()).toBeNull();
  });

  it("Admin: liefert die User-Id für die Mutation", async () => {
    mockedSession.mockResolvedValue({ user: { id: "admin-1" } });
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: true });
    expect(await adminUserId()).toBe("admin-1");
  });
});
