import { describe, expect, it } from "vitest";
import {
  consentRedirectTarget,
  hasCurrentConsent,
  PRIVACY_POLICY_VERSION,
  safeNextPath,
} from "@/lib/privacy-consent";

/**
 * Einwilligung (25.09.2026): wann umgeleitet wird, und dass `next` kein
 * offener Redirect ist.
 */

describe("hasCurrentConsent", () => {
  it("nur die aktuelle Version zählt", () => {
    expect(hasCurrentConsent(PRIVACY_POLICY_VERSION)).toBe(true);
    expect(hasCurrentConsent("2020-01-01")).toBe(false);
    expect(hasCurrentConsent(null)).toBe(false);
    expect(hasCurrentConsent(undefined)).toBe(false);
  });
});

describe("consentRedirectTarget", () => {
  it("leitet auf die Zustimmung um und merkt sich Pfad und Query", () => {
    expect(consentRedirectTarget("/fr/tickets/abc", "?tab=x", "fr")).toBe(
      `/fr/zustimmung?next=${encodeURIComponent("/fr/tickets/abc?tab=x")}`,
    );
    expect(consentRedirectTarget("/de", "", "de")).toBe(
      `/de/zustimmung?next=${encodeURIComponent("/de")}`,
    );
  });

  it.each(["zustimmung", "datenschutz", "impressum", "faq"])(
    "/%s bleibt ohne Einwilligung erreichbar (keine Schleife)",
    (segment) => {
      expect(consentRedirectTarget(`/de/${segment}`, "", "de")).toBeNull();
    },
  );
});

describe("safeNextPath — Open-Redirect-Schutz", () => {
  it.each(["/de", "/fr/tickets/abc", "/it?tab=kontrovers", "/de/profil/x"])(
    "übernimmt den eigenen Pfad %s",
    (next) => {
      expect(safeNextPath(next, "de")).toBe(next);
    },
  );

  it.each([
    "//evil.example",
    "https://evil.example/de",
    "/de//evil.example",
    "/\\evil.example",
    "/de/\\evil.example",
    "/\t/evil.example",
    "/de\n//evil.example",
    "/xx/tickets",
    "de/tickets",
    "",
    "/de/zustimmung",
    "/de/zustimmung?next=/de",
  ])("verwirft %s zugunsten des Boards", (next) => {
    expect(safeNextPath(next, "fr")).toBe("/fr");
  });

  it("verwirft Nicht-Strings und überlange Werte", () => {
    expect(safeNextPath(["/de"], "de")).toBe("/de");
    expect(safeNextPath(undefined, "it")).toBe("/it");
    expect(safeNextPath(`/de/${"a".repeat(3000)}`, "de")).toBe("/de");
  });
});
