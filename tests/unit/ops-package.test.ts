import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Das Laufzeit-Image migriert beim Start mit der Prisma-CLI aus `ops/`
 * (eigenes Lockfile, 14.09.2026). Weicht deren Version vom Root-Projekt ab,
 * würde in Produktion eine andere Prisma-Version migrieren als die, gegen
 * die lokal und in CI getestet wurde. Dieser Test fällt beim Upgrade von
 * Prisma auf, wenn `ops/` vergessen ging.
 */

type Lockfile = { packages: Record<string, { version?: string }> };
type PackageJson = {
  dependencies: Record<string, string>;
  overrides?: Record<string, string>;
};

const root = process.cwd();

function read<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8")) as T;
}

const rootLock = read<Lockfile>("package-lock.json");
const opsLock = read<Lockfile>("ops/package-lock.json");
const rootPackage = read<PackageJson>("package.json");
const opsPackage = read<PackageJson>("ops/package.json");

/** `^MAJOR.MINOR.PATCH` — die einzige Form, die die Overrides benutzen. */
function satisfiesCaret(version: string, range: string): boolean {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || !parts) {
    return false;
  }
  const [min, actual] = [match.slice(1), parts.slice(1)].map((xs) =>
    xs.map(Number),
  ) as [number[], number[]];
  if (actual[0] !== min[0]) {
    return false;
  }
  for (let i = 1; i < 3; i += 1) {
    if (actual[i]! !== min[i]!) {
      return actual[i]! > min[i]!;
    }
  }
  return true;
}

describe("ops/ — Werkzeuge des Container-Starts", () => {
  it("führt nur die Prisma-CLI und dotenv (für prisma.config.ts)", () => {
    expect(Object.keys(opsPackage.dependencies).sort()).toEqual([
      "dotenv",
      "prisma",
    ]);
  });

  it.each(["prisma", "dotenv"])(
    "%s ist exakt gepinnt und identisch mit dem Root-Lockfile",
    (name) => {
      const pinned = opsPackage.dependencies[name];
      const rootVersion = rootLock.packages[`node_modules/${name}`]?.version;
      const opsVersion = opsLock.packages[`node_modules/${name}`]?.version;

      expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
      expect(rootVersion).toBeDefined();
      expect(pinned).toBe(rootVersion);
      expect(opsVersion).toBe(rootVersion);
    },
  );

  it("das Lockfile gehört zu genau diesen Abhängigkeiten", () => {
    const declared = opsLock.packages[""] as {
      dependencies?: Record<string, string>;
    };
    expect(declared.dependencies).toEqual(opsPackage.dependencies);
  });

  /**
   * Sicherheits-Overrides (25.09.2026): Das Root-Projekt hob `deepmerge-ts`
   * und `mysql2` per Override über verwundbare Versionen, `ops/` nicht — das
   * Laufzeit-Image trug damit die alten Versionen, und `npm audit` meldete
   * «high». Jeder Root-Override, dessen Paket auch im ops-Baum vorkommt, muss
   * in `ops/` identisch stehen und dort tatsächlich greifen.
   */
  it("übernimmt jeden Root-Override, dessen Paket im ops-Baum vorkommt", () => {
    const rootOverrides = rootPackage.overrides ?? {};
    const opsOverrides = opsPackage.overrides ?? {};
    for (const [name, range] of Object.entries(rootOverrides)) {
      const installed = opsLock.packages[`node_modules/${name}`]?.version;
      if (installed === undefined) {
        continue;
      }
      expect(opsOverrides[name], `Override für ${name} fehlt in ops/`).toBe(
        range,
      );
      expect(
        satisfiesCaret(installed, range),
        `${name}@${installed} erfüllt ${range} nicht`,
      ).toBe(true);
    }
  });

  it("führt keine Overrides, die das Root-Projekt nicht kennt", () => {
    const rootOverrides = rootPackage.overrides ?? {};
    for (const [name, range] of Object.entries(opsPackage.overrides ?? {})) {
      expect(rootOverrides[name]).toBe(range);
    }
  });
});
