import { describe, expect, it } from "vitest";

/**
 * Sprach-Weiterleitung (E11, 04.09.2026): Angemeldete sehen die Anwendung
 * überall in ihrer Profilsprache. Sicherheitskritisch ist hier vor allem die
 * Schleifenfreiheit — der Layout leitet um, und eine Umleitung, die sich
 * selbst erneut auslöst, legt jede Seite lahm.
 */
import { localeRedirectTarget } from "@/lib/locale-redirect";
import { routing } from "@/i18n/routing";

describe("localeRedirectTarget", () => {
  it("leitet auf die Profilsprache um", () => {
    expect(localeRedirectTarget("/fr", "de")).toBe("/de");
    expect(localeRedirectTarget("/fr/tickets/abc", "de")).toBe(
      "/de/tickets/abc",
    );
    expect(localeRedirectTarget("/de/einstellungen", "it")).toBe(
      "/it/einstellungen",
    );
  });

  it("leitet nicht um, wenn die Sprache schon stimmt", () => {
    expect(localeRedirectTarget("/de", "de")).toBeNull();
    expect(localeRedirectTarget("/de/tickets/abc", "de")).toBeNull();
  });

  it("lässt Pfade ohne bekannte Locale unangetastet", () => {
    expect(localeRedirectTarget("/", "de")).toBeNull();
    expect(localeRedirectTarget("/api/health", "de")).toBeNull();
    expect(localeRedirectTarget("/deutsch/x", "de")).toBeNull();
    expect(localeRedirectTarget("/def", "de")).toBeNull();
  });

  it("erzeugt nie eine Schleife: das Ziel leitet selbst nicht weiter", () => {
    const pfade = [
      "/de",
      "/fr",
      "/it",
      "/fr/tickets/abc",
      "/it/admin",
      "/de/profil/xyz",
      "/",
      "/deutsch",
    ];
    for (const locale of routing.locales) {
      for (const pfad of pfade) {
        const ziel = localeRedirectTarget(pfad, locale);
        if (ziel !== null) {
          expect(localeRedirectTarget(ziel, locale)).toBeNull();
        }
      }
    }
  });

  it("behält Unterpfade samt Sonderzeichen bei", () => {
    expect(localeRedirectTarget("/fr/tickets/a-b_c.d", "it")).toBe(
      "/it/tickets/a-b_c.d",
    );
  });

  it("bleibt auf der eigenen Anwendung (kein offener Redirect)", () => {
    // Der Pfad kommt aus `nextUrl.pathname` und beginnt immer mit «/» —
    // das Ergebnis darf trotzdem nie als absolute URL interpretierbar sein.
    for (const pfad of ["/fr", "/fr/x", "/fr//evil.example.com"]) {
      const ziel = localeRedirectTarget(pfad, "de");
      expect(ziel).not.toBeNull();
      expect(ziel!.startsWith("/de")).toBe(true);
      expect(ziel).not.toMatch(/^https?:/);
    }
  });
});
