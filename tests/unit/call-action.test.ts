import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_FAILURE_EVENT,
  actionFailureKind,
  callAction,
  type ActionFailureKind,
} from "@/lib/call-action";

/**
 * Server-Action-Aufrufe scheitern nicht mehr still (14.09.2026).
 * Anlass: Nach einem Deploy kennt ein offener Tab die Action-IDs des alten
 * Builds nicht mehr — der Knopf «tat nichts».
 */

describe("callAction", () => {
  let received: ActionFailureKind[];

  beforeEach(() => {
    received = [];
    const target = new EventTarget();
    target.addEventListener(ACTION_FAILURE_EVENT, (event) => {
      received.push((event as CustomEvent<ActionFailureKind>).detail);
    });
    vi.stubGlobal("window", target);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reicht das Ergebnis einer erfolgreichen Action unverändert durch", async () => {
    const result = await callAction(async () => ({
      ok: false as const,
      error: "rate_limited",
    }));
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(received).toEqual([]);
  });

  it("meldet eine Action aus einem älteren Build als «stale» und liefert null", async () => {
    const result = await callAction(async () => {
      throw new UnrecognizedActionError('Server Action "abc" was not found');
    });
    expect(result).toBeNull();
    expect(received).toEqual(["stale"]);
  });

  it("meldet jeden anderen geworfenen Fehler als «failed» und liefert null", async () => {
    const result = await callAction(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toBeNull();
    expect(received).toEqual(["failed"]);
  });

  it("unterscheidet die Fehlerarten", () => {
    expect(actionFailureKind(new UnrecognizedActionError("x"))).toBe("stale");
    expect(actionFailureKind(new Error("x"))).toBe("failed");
    expect(actionFailureKind("kein Error-Objekt")).toBe("failed");
  });
});

/**
 * Statischer Wächter: Jede Client-Komponente, die eine Server Action
 * importiert, ruft sie über `callAction` auf. Ein neues Formular, das die
 * Action direkt `await`et, würde nach dem nächsten Deploy wieder still
 * scheitern — dieser Test findet das beim Schreiben, nicht beim Besucher.
 */
describe("Server Actions in Client-Komponenten", () => {
  const componentsDir = path.join(process.cwd(), "src", "components");

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return tsxFiles(full);
      return entry.name.endsWith(".tsx") ? [full] : [];
    });
  }

  const importPattern = /import\s+\{([^}]+)\}\s+from\s+"@\/actions\/[a-z-]+";/g;

  const callers = tsxFiles(componentsDir).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const names = [...source.matchAll(importPattern)].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name && !name.startsWith("type ")),
    );
    return names.length > 0
      ? [{ file: path.relative(process.cwd(), file), source, names }]
      : [];
  });

  it("findet die Aufrufer überhaupt (sonst prüft der Wächter nichts)", () => {
    expect(callers.length).toBeGreaterThanOrEqual(10);
  });

  it.each(callers.map((caller) => [caller.file, caller] as const))(
    "%s ruft Actions nur über callAction auf",
    (_file, { source, names }) => {
      expect(source).toContain('from "@/lib/call-action"');
      for (const name of names) {
        expect(source).not.toMatch(new RegExp(`await\\s+${name}\\(`));
      }
    },
  );
});
