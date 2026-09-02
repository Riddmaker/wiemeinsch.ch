import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  createNonce,
  staticSecurityHeaders,
  TURNSTILE_ORIGIN,
} from "@/lib/security-headers";

/**
 * Security-Header (P13.2). Der Sinn dieser Tests ist nicht, den String
 * abzuschreiben, sondern die Eigenschaften festzunageln, die eine CSP
 * überhaupt erst wirksam machen — und die beim Debuggen erfahrungsgemäss als
 * Erstes aufgeweicht werden.
 */

const prod = { isDev: false, isHttps: true };
const dev = { isDev: true, isHttps: false };

function directive(csp: string, name: string): string {
  const found = csp
    .split("; ")
    .find((part) => part === name || part.startsWith(`${name} `));
  expect(found, `Direktive ${name} fehlt`).toBeDefined();
  return found as string;
}

describe("buildContentSecurityPolicy (P13.2)", () => {
  const csp = buildContentSecurityPolicy("NONCE", prod);

  it("erlaubt in Produktion KEINE Inline-Skripte", () => {
    expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("erlaubt in Produktion kein eval", () => {
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("bindet den Nonce ein und kombiniert ihn mit strict-dynamic", () => {
    const scriptSrc = directive(csp, "script-src");
    expect(scriptSrc).toContain("'nonce-NONCE'");
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("lässt Turnstile zu — Script, Verbindung und Widget-Iframe", () => {
    expect(directive(csp, "script-src")).toContain(TURNSTILE_ORIGIN);
    expect(directive(csp, "connect-src")).toContain(TURNSTILE_ORIGIN);
    expect(directive(csp, "frame-src")).toContain(TURNSTILE_ORIGIN);
  });

  it("sperrt Plugins, fremde Basis-URLs, fremde Formularziele und Einbettung", () => {
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("weicht style-src nur für ATTRIBUTE auf, nicht für <style>-Blöcke", () => {
    // Ein style-Attribut kann kein Skript ausführen; ein <style>-Block wäre
    // eine echte Injektionsfläche (CSS-Exfiltration).
    expect(directive(csp, "style-src")).not.toContain("'unsafe-inline'");
    expect(directive(csp, "style-src-attr")).toBe(
      "style-src-attr 'unsafe-inline'",
    );
  });

  it("erzwingt HTTPS nur, wenn die App wirklich hinter TLS läuft", () => {
    expect(csp).toContain("upgrade-insecure-requests");
    expect(buildContentSecurityPolicy("NONCE", dev)).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("Dev-Ausnahmen gelten ausschliesslich im Dev-Modus", () => {
    const devCsp = buildContentSecurityPolicy("NONCE", dev);
    expect(devCsp).toContain("'unsafe-eval'");
    // Im Dev ohne Nonce in style-src — sonst ignoriert der Browser das
    // 'unsafe-inline' daneben und das devtools-Overlay flutet die Konsole.
    const devStyle = directive(devCsp, "style-src");
    expect(devStyle).toContain("'unsafe-inline'");
    expect(devStyle).not.toContain("nonce-");
  });

  it("Skript-Nonce gilt auch im Dev — nur die Styles sind gelockert", () => {
    expect(
      directive(buildContentSecurityPolicy("NONCE", dev), "script-src"),
    ).toContain("'nonce-NONCE'");
  });
});

describe("createNonce", () => {
  it("liefert bei jedem Aufruf einen anderen Wert", () => {
    const values = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(values.size).toBe(50);
  });

  it("liefert einen Wert, der in eine CSP passt (base64, keine Anführungszeichen)", () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});

describe("staticSecurityHeaders (P13.2)", () => {
  it("setzt die Basis-Header unabhängig vom Transport", () => {
    const headers = staticSecurityHeaders(dev);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  it("verweigert alle Geräte-APIs (Least Privilege)", () => {
    const policy = staticSecurityHeaders(prod)["Permissions-Policy"] ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it("sendet HSTS nur über HTTPS — sonst sperrt es die lokale Umgebung aus", () => {
    expect(staticSecurityHeaders(prod)["Strict-Transport-Security"]).toContain(
      "max-age=63072000",
    );
    expect(
      staticSecurityHeaders(dev)["Strict-Transport-Security"],
    ).toBeUndefined();
  });
});
