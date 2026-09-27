import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVACY_POLICY_VERSION } from "@/lib/privacy-consent";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { session: { findUnique } } }));
// Siehe proxy-cache-control.test.ts: next-intl ist in Vitest nicht auflösbar.
vi.mock("next-intl/middleware", () => ({
  default: () => () => NextResponse.next(),
}));

import { consentGateTarget, SESSION_COOKIES } from "@/lib/consent-gate";
import proxy from "@/proxy";

/**
 * Einwilligungs-Gate im Proxy (27.09.2026): Im Layout griff es bei
 * Navigationen im Browser nicht. Hier: wann die DB gefragt wird, und wohin
 * umgeleitet wird.
 */

const FUTURE = new Date(Date.now() + 86_400_000);

function request(path: string, cookie?: string): NextRequest {
  const req = new NextRequest(`http://localhost:3000${path}`);
  if (cookie) {
    req.cookies.set(cookie, "token-123");
  }
  return req;
}

function sessionRow(
  privacyConsentVersion: string | null,
  expires = FUTURE,
  preferredLocale = "FR",
) {
  return { expires, user: { preferredLocale, privacyConsentVersion } };
}

beforeEach(() => {
  findUnique.mockReset();
});

describe("consentGateTarget", () => {
  it("Gäste: keine Abfrage, keine Umleitung", async () => {
    expect(await consentGateTarget(request("/de/tickets/new"))).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("Pfade ohne Locale überlässt es next-intl", async () => {
    const cookie = SESSION_COOKIES[0];
    expect(await consentGateTarget(request("/", cookie))).toBeNull();
    expect(await consentGateTarget(request("/tickets", cookie))).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each(SESSION_COOKIES)(
    "ohne Einwilligung → Zustimmung in der Profilsprache (%s)",
    async (cookie) => {
      findUnique.mockResolvedValue(sessionRow(null));
      expect(
        await consentGateTarget(request("/de/u/brienzersee_k7x2?x=1", cookie)),
      ).toBe(
        `/fr/zustimmung?next=${encodeURIComponent("/de/u/brienzersee_k7x2?x=1")}`,
      );
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sessionToken: "token-123" } }),
      );
    },
  );

  it("veraltete Version zählt wie keine", async () => {
    findUnique.mockResolvedValue(sessionRow("2020-01-01"));
    expect(await consentGateTarget(request("/fr", SESSION_COOKIES[1]))).toMatch(
      /^\/fr\/zustimmung\?next=/,
    );
  });

  it("mit aktueller Einwilligung: keine Umleitung", async () => {
    findUnique.mockResolvedValue(sessionRow(PRIVACY_POLICY_VERSION));
    expect(
      await consentGateTarget(request("/fr/tickets/new", SESSION_COOKIES[0])),
    ).toBeNull();
  });

  it.each(["/fr/zustimmung", "/fr/datenschutz", "/fr/impressum", "/fr/faq"])(
    "%s bleibt ohne Einwilligung erreichbar",
    async (path) => {
      findUnique.mockResolvedValue(sessionRow(null));
      expect(
        await consentGateTarget(request(path, SESSION_COOKIES[0])),
      ).toBeNull();
    },
  );

  it("unbekannte oder abgelaufene Session = Gast", async () => {
    findUnique.mockResolvedValue(null);
    expect(
      await consentGateTarget(request("/de", SESSION_COOKIES[0])),
    ).toBeNull();
    findUnique.mockResolvedValue(sessionRow(null, new Date(Date.now() - 1000)));
    expect(
      await consentGateTarget(request("/de", SESSION_COOKIES[0])),
    ).toBeNull();
  });

  it("DB-Fehler: offen scheitern (die Actions sichern ab), mit Log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockRejectedValue(new Error("connection refused"));
    expect(
      await consentGateTarget(request("/de", SESSION_COOKIES[0])),
    ).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("consent_gate_lookup_failed"),
    );
    log.mockRestore();
  });
});

describe("proxy — Einwilligungs-Gate", () => {
  it("leitet um und trägt trotzdem die Schutz-Header", async () => {
    findUnique.mockResolvedValue(sessionRow(null, FUTURE, "DE"));
    const response = await proxy(
      request("/de/einstellungen", SESSION_COOKIES[0]),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `http://localhost:3000/de/zustimmung?next=${encodeURIComponent("/de/einstellungen")}`,
    );
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});
