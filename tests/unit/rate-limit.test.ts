import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  checkClientIpRateLimit,
  checkRateLimit,
  getClientIp,
  UNTRUSTED_CLIENT_IP,
} from "@/lib/rate-limit";

// DB-Integrationstest (läuft vollständig im App-Container, sonst übersprungen).
describe.skipIf(!process.env.DATABASE_URL)(
  "checkRateLimit (E2: Postgres, T4)",
  () => {
    const identifier = `test-${Date.now()}`;

    afterAll(async () => {
      await prisma.rateLimitBucket.deleteMany({
        where: { key: { contains: identifier } },
      });
      await prisma.$disconnect();
    });

    it("erlaubt bis zum Limit, blockt danach mit Retry-After", async () => {
      const opts = { scope: "test", identifier, limit: 3, windowSeconds: 60 };
      for (let i = 0; i < 3; i++) {
        expect((await checkRateLimit(opts)).ok).toBe(true);
      }
      const blocked = await checkRateLimit(opts);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    });

    it("getrennte Scopes zählen getrennt", async () => {
      const a = await checkRateLimit({
        scope: "test-a",
        identifier,
        limit: 1,
        windowSeconds: 60,
      });
      const b = await checkRateLimit({
        scope: "test-b",
        identifier,
        limit: 1,
        windowSeconds: 60,
      });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
    });
  },
);

/**
 * IP-Schicht (P13.3) — braucht keine DB, weil der interessante Fall genau der
 * ist, in dem gar nicht gezaehlt wird.
 */
describe("checkClientIpRateLimit (P13.3)", () => {
  const original = process.env.TRUST_PROXY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = original;
    }
  });

  const opts = { scope: "ai-ip", limit: 1, windowSeconds: 60 };

  it("ohne vertrauenswuerdigen Proxy: uebersprungen statt gemeinsamer Bucket", async () => {
    process.env.TRUST_PROXY = "false";
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
    expect(getClientIp(headers)).toBe(UNTRUSTED_CLIENT_IP);
    // Kein DB-Zugriff: waere gezaehlt worden, wuerde der zweite Aufruf blocken.
    for (let i = 0; i < 5; i++) {
      expect((await checkClientIpRateLimit(headers, opts)).ok).toBe(true);
    }
  });

  it("gefaelschte Proxy-Header werden ohne TRUST_PROXY ignoriert", async () => {
    process.env.TRUST_PROXY = "false";
    const spoofed = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(getClientIp(spoofed)).toBe(UNTRUSTED_CLIENT_IP);
  });

  it("hinter dem Proxy zaehlt die Cloudflare-Adresse, nicht x-forwarded-for", () => {
    process.env.TRUST_PROXY = "true";
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "1.2.3.4",
    });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  it("hinter dem Proxy ohne jeden IP-Header: eigener Bucket 'unknown'", () => {
    process.env.TRUST_PROXY = "true";
    // Eine Anfrage, die Cloudflare umgangen hat — die soll hart limitiert
    // werden, nicht durchgewunken.
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});
