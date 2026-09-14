import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Dauerhafter Datenschutz-Guard (P11.3, nDSG): Die demografischen Spalten
 * dürfen im Quellcode NUR an den wenigen Stellen vorkommen, die sie
 * definitionsgemäss brauchen — Schema, Validierung, die eigene
 * Einstellungs-Seite und ihre Action.
 *
 * Wer eine Demografie-Spalte irgendwo sonst selektiert (Board, Ticketseite,
 * Profil, API-Route, Service), lässt diesen Test rot werden. Das ist Absicht:
 * Eine neue Fundstelle ist ein bewusster nDSG-Entscheid und gehört in die
 * Allowlist — oder eben nicht in den Code.
 */

const DEMOGRAPHIC_FIELDS = [
  "birthYear",
  "gender",
  "education",
  "postalCode",
  "occupation",
] as const;

/** Stellen, an denen die Felder vorkommen dürfen (relative Pfade ab Repo-Wurzel). */
const ALLOWLIST = [
  "src/actions/profile.ts",
  "src/app/[locale]/einstellungen/page.tsx",
  "src/components/profile/ProfileSettingsForm.tsx",
  "src/lib/user-projection.ts",
  "src/lib/validation/profile.ts",
].map((path) => path.split("/").join(sep));

const ROOT = process.cwd();
const SCAN_DIR = join(ROOT, "src");
const SKIP_DIRS = new Set(["generated", "node_modules"]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        files.push(...sourceFiles(full));
      }
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("Demografie verlässt den Server nicht (P11.3)", () => {
  const files = sourceFiles(SCAN_DIR);

  it("findet überhaupt Quelldateien (Schutz vor stillem Leerlauf)", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  for (const field of DEMOGRAPHIC_FIELDS) {
    it(`«${field}» kommt nur in der Allowlist vor`, () => {
      // Nur Code-Vorkommen (Objekt-Key, Property-Zugriff, Argument) — das
      // englische Wort in einem Prompt-Text ist kein Datenschutz-Problem.
      const pattern = new RegExp(
        `(\\.${field}\\b|\\b${field}\\b\\s*[:.,)}\\]=;])`,
      );
      const offenders = files
        .filter((file) => pattern.test(readFileSync(file, "utf8")))
        .map((file) => relative(ROOT, file))
        .filter((file) => !ALLOWLIST.includes(file));
      expect(
        offenders,
        `Demografie-Feld «${field}» ausserhalb der Allowlist: ${offenders.join(", ")}`,
      ).toEqual([]);
    });
  }

  it("die Allowlist-Dateien existieren noch (Schutz vor stillem Umbenennen)", () => {
    for (const entry of ALLOWLIST) {
      expect(() => readFileSync(join(ROOT, entry), "utf8")).not.toThrow();
    }
  });
});
