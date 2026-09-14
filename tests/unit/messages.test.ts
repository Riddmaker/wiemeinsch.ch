import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parse,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";
import { routing } from "@/i18n/routing";

/**
 * Katalog-Abnahme (T14.5): DE/FR/IT müssen deckungsgleiche Schlüsselmengen
 * haben. Fehlt ein Schlüssel in einer Sprache, wirft next-intl zur Laufzeit —
 * und zwar erst auf der Seite, die ihn braucht. Dieser Test findet die Lücke
 * beim Build statt beim Besucher.
 *
 * Die Sprachliste kommt aus `routing`, nicht aus einer zweiten Aufzählung:
 * eine vierte Sprache wäre damit automatisch mitgeprüft (HABIT 10).
 */

const messagesDir = path.join(process.cwd(), "messages");

type Catalogue = { [key: string]: string | Catalogue };

function loadCatalogue(locale: string): Catalogue {
  return JSON.parse(
    readFileSync(path.join(messagesDir, `${locale}.json`), "utf8"),
  ) as Catalogue;
}

/** Alle Blatt-Pfade in Punkt-Notation, sortiert. */
function leafKeys(catalogue: Catalogue, prefix = ""): string[] {
  return Object.entries(catalogue)
    .flatMap(([key, value]) => {
      const full = prefix ? `${prefix}.${key}` : key;
      return typeof value === "object" && value !== null
        ? leafKeys(value, full)
        : [full];
    })
    .sort();
}

/** Alle Blätter als flache Map Pfad → Text. */
function flatten(catalogue: Catalogue, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalogue)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      for (const [k, v] of flatten(value, full)) out.set(k, v);
    } else if (typeof value === "string") {
      out.set(full, value);
    }
  }
  return out;
}

/**
 * Argument-Namen einer ICU-Nachricht über den echten Parser — eine
 * Regex würde in `{count, plural, one {Zustimmung}}` auch den Zweigtext
 * `Zustimmung` für ein Argument halten.
 */
function argumentNames(text: string): string[] {
  const names = new Set<string>();
  const walk = (elements: MessageFormatElement[]): void => {
    for (const element of elements) {
      if ("value" in element && typeof element.value === "string") {
        if (element.type !== TYPE.literal) names.add(element.value);
      }
      if ("options" in element && element.options) {
        for (const option of Object.values(element.options)) {
          walk(option.value);
        }
      }
      if ("children" in element && element.children) {
        walk(element.children);
      }
    }
  };
  walk(parse(text));
  return [...names].sort();
}

const locales = routing.locales;
const reference = routing.defaultLocale;
const catalogues = new Map(
  locales.map((locale) => [locale, loadCatalogue(locale)] as const),
);
const referenceKeys = leafKeys(catalogues.get(reference)!);

describe("Message-Kataloge", () => {
  it("prüft alle Sprachen der Routing-Konfiguration", () => {
    expect([...locales].sort()).toEqual(["de", "fr", "it"]);
    expect(referenceKeys.length).toBeGreaterThan(0);
  });

  it.each(locales.filter((locale) => locale !== reference))(
    "%s hat exakt dieselben Schlüssel wie die Referenz",
    (locale) => {
      const keys = leafKeys(catalogues.get(locale)!);
      // toEqual auf den sortierten Listen nennt fehlende UND überzählige
      // Schlüssel beim Namen — eine blosse Zähler-Prüfung würde ein Paar aus
      // Tippfehler und Auslassung übersehen.
      expect(keys).toEqual(referenceKeys);
    },
  );

  it.each(locales)("%s hat keinen leeren Wert", (locale) => {
    const empty: string[] = [];
    const walk = (catalogue: Catalogue, prefix = ""): void => {
      for (const [key, value] of Object.entries(catalogue)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "object" && value !== null) {
          walk(value, full);
        } else if (typeof value !== "string" || value.trim() === "") {
          empty.push(full);
        }
      }
    };
    walk(catalogues.get(locale)!);
    expect(empty).toEqual([]);
  });

  it.each(locales.filter((locale) => locale !== reference))(
    "%s übernimmt die ICU-Argumente der Referenz",
    (locale) => {
      const referenceTexts = flatten(catalogues.get(reference)!);
      const translated = flatten(catalogues.get(locale)!);

      const mismatches: string[] = [];
      for (const [key, text] of referenceTexts) {
        const other = translated.get(key);
        if (other === undefined) continue; // vom Schlüssel-Test abgedeckt
        const expected = argumentNames(text);
        const actual = argumentNames(other);
        if (expected.join(",") !== actual.join(",")) {
          mismatches.push(
            `${key}: erwartet [${expected.join(", ")}], gefunden [${actual.join(", ")}]`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    },
  );

  it.each(locales)("%s ist syntaktisch gültiges ICU", (locale) => {
    const invalid: string[] = [];
    for (const [key, text] of flatten(catalogues.get(locale)!)) {
      try {
        parse(text);
      } catch (error) {
        invalid.push(
          `${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    expect(invalid).toEqual([]);
  });
});
