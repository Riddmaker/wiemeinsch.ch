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

const root = process.cwd();

function read<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8")) as T;
}

const rootLock = read<Lockfile>("package-lock.json");
const opsLock = read<Lockfile>("ops/package-lock.json");
const opsPackage = read<{ dependencies: Record<string, string> }>(
  "ops/package.json",
);

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
});
