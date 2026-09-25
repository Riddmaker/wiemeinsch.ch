import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

// next-intl importiert `next/server` ohne Endung, was Vitests ESM-Auflösung
// nicht findet. Geprüft wird ohnehin nur, was der Proxy SELBST an die
// Antwort hängt — das Locale-Routing ist durch die E2E-Suite abgedeckt.
vi.mock("next-intl/middleware", () => ({
  default: () => () => NextResponse.next(),
}));

import proxy, { PAGE_CACHE_CONTROL } from "@/proxy";

/**
 * `no-transform` auf jeder Seite (Code-Review 25.09.2026): Cloudflares Email
 * Obfuscation würde die Adresse im Impressum durch ein Skript ohne Nonce
 * ersetzen, das die CSP blockiert. Dass Next den Wert des Proxys bis in die
 * Antwort durchreicht, ist am Prod-Image per curl belegt — hier wird
 * festgehalten, dass der Proxy ihn auf jede Antwort setzt.
 */
describe("proxy — Cache-Control", () => {
  it("setzt no-transform ohne das Caching zu ändern", () => {
    expect(PAGE_CACHE_CONTROL).toContain("no-transform");
    expect(PAGE_CACHE_CONTROL).toContain("no-store");
    expect(PAGE_CACHE_CONTROL).toContain("private");
  });

  it.each(["http://localhost:3000/de/impressum", "http://localhost:3000/"])(
    "%s trägt den Header",
    (url) => {
      const response = proxy(new NextRequest(url));
      expect(response.headers.get("Cache-Control")).toBe(PAGE_CACHE_CONTROL);
    },
  );
});
