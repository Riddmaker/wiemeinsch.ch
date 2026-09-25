import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Aufbewahrungsfristen (25.09.2026): Der stündliche Cron löscht abgelaufene
 * Rate-Limit-Zähler, Anmelde-Links und Sessions — die Fristen stehen in der
 * Datenschutzerklärung und müssen deshalb unabhängig vom Verkehr gelten.
 */

const prismaMock = vi.hoisted(() => ({
  rateLimitBucket: { deleteMany: vi.fn() },
  verificationToken: { deleteMany: vi.fn() },
  session: { deleteMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { purgeExpiredData } from "@/services/data-retention";

describe("purgeExpiredData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    prismaMock.rateLimitBucket.deleteMany.mockResolvedValue({ count: 4 });
    prismaMock.verificationToken.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.session.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("löscht nur Abgelaufenes und meldet die Zahlen", async () => {
    expect(await purgeExpiredData()).toEqual({
      rateLimits: 4,
      verificationTokens: 2,
      sessions: 1,
    });
    const now = new Date("2026-09-25T12:00:00Z");
    expect(prismaMock.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { expires: { lt: now } },
    });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { expires: { lt: now } },
    });
    // Zählfenster: älter als das längste Fenster (1 h) — die Frist von
    // höchstens zwei Stunden ergibt sich mit dem stündlichen Takt.
    expect(prismaMock.rateLimitBucket.deleteMany).toHaveBeenCalledWith({
      where: { windowStart: { lt: new Date("2026-09-25T11:00:00Z") } },
    });
    vi.useRealTimers();
  });
});
