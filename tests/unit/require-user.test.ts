import { beforeEach, describe, expect, it, vi } from "vitest";

// getServerSession mocken — testet den Guard und das Action-Muster ohne HTTP-Stack.
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

import { getServerSession } from "next-auth";
import {
  authenticatedUserId,
  requireUser,
  UnauthorizedError,
} from "@/lib/require-user";
import { updateProfile } from "@/actions/profile";

const mockedSession = vi.mocked(getServerSession);

describe("requireUser / geschützte Server Action (T4)", () => {
  beforeEach(() => {
    mockedSession.mockReset();
  });

  it("wirft UnauthorizedError ohne Session", async () => {
    mockedSession.mockResolvedValue(null);
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("liefert die User-Id mit Session", async () => {
    mockedSession.mockResolvedValue({ user: { id: "user-1" } });
    expect(await requireUser()).toEqual({ id: "user-1" });
  });

  it("Action ohne Session: abgelehnt, keine Mutation", async () => {
    mockedSession.mockResolvedValue(null);
    const result = await updateProfile({ preferredLocale: "DE" });
    expect(result).toEqual({ ok: false, error: "unauthorized" });
  });

  // authenticatedUserId ist die Result-Variante für Actions mit Fehlercodes
  // (geteilt von tickets/votes/statements seit P9).
  it("authenticatedUserId: null statt Exception ohne Session", async () => {
    mockedSession.mockResolvedValue(null);
    expect(await authenticatedUserId()).toBeNull();
  });

  it("authenticatedUserId: User-Id mit Session", async () => {
    mockedSession.mockResolvedValue({ user: { id: "user-1" } });
    expect(await authenticatedUserId()).toBe("user-1");
  });
});
