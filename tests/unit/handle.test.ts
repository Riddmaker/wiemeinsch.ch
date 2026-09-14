import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Öffentlicher @handle (P4, überarbeitet 04.09.2026).
 *
 * Sicherheitsrelevant sind zwei Eigenschaften: Der Handle darf KEINEN Bezug
 * zur Mailadresse haben (er steht öffentlich über jedem Beitrag und ist nicht
 * änderbar), und eine Kollision auf der `@unique`-Spalte darf die
 * Registrierung nicht abbrechen. DB ist gemockt.
 */

const prismaMock = vi.hoisted(() => ({
  user: { update: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  assignHandle,
  generateHandle,
  HANDLE_SUFFIX_LENGTH,
  HANDLE_WORDS,
} from "@/lib/handle";

/** Fehler, wie ihn Prisma bei verletzter Unique-Constraint wirft. */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

/** Zerlegt einen Handle in Wort und Suffix (letzter Unterstrich trennt). */
function split(handle: string): { word: string; suffix: string } {
  const index = handle.lastIndexOf("_");
  return {
    word: handle.slice(0, index),
    suffix: handle.slice(index + 1),
  };
}

beforeEach(() => {
  prismaMock.user.update.mockReset();
  prismaMock.user.update.mockResolvedValue({});
});

describe("generateHandle", () => {
  it("besteht aus einem Wort der Liste und einem Base36-Suffix", () => {
    for (let i = 0; i < 200; i += 1) {
      const { word, suffix } = split(generateHandle());
      expect(HANDLE_WORDS).toContain(word);
      expect(suffix).toHaveLength(HANDLE_SUFFIX_LENGTH);
      expect(suffix).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("erzeugt nur URL-sichere Zeichen (kein Escaping nötig)", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateHandle()).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("variiert über die Aufrufe (kein konstanter Wert)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(generateHandle());
    }
    expect(seen.size).toBeGreaterThan(100);
  });

  it("respektiert eine abweichende Suffix-Länge", () => {
    expect(split(generateHandle(6)).suffix).toHaveLength(6);
  });
});

describe("Wortliste", () => {
  it("enthält keine Duplikate", () => {
    expect(new Set(HANDLE_WORDS).size).toBe(HANDLE_WORDS.length);
  });

  it("enthält ausschliesslich ASCII-Kleinbuchstaben", () => {
    for (const word of HANDLE_WORDS) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });
});

describe("assignHandle", () => {
  it("schreibt den Handle auf den übergebenen User", async () => {
    const handle = await assignHandle("user-1");

    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { handle },
    });
  });

  it("enthält keinen Bestandteil der Mailadresse", async () => {
    // Regressionstest: Bis 04.09.2026 wurde der Handle aus dem Mailpräfix
    // gebildet — `cedricmeier91@gmx.ch` wurde zu `@cedricmeier91_ev0c`.
    const handles = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      handles.add(await assignHandle("user-1"));
    }

    for (const handle of handles) {
      expect(handle).not.toContain("cedricmeier91");
      expect(HANDLE_WORDS).toContain(split(handle).word);
    }
  });

  it("versucht es nach einer Kollision mit einem neuen Handle", async () => {
    prismaMock.user.update
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValue({});

    const handle = await assignHandle("user-1");

    expect(prismaMock.user.update).toHaveBeenCalledTimes(3);
    expect(HANDLE_WORDS).toContain(split(handle).word);
  });

  it("weicht nach dauerhaften Kollisionen auf einen langen Suffix aus", async () => {
    // Alle acht regulären Versuche kollidieren; erst der UUID-Suffix greift.
    let call = 0;
    prismaMock.user.update.mockImplementation(() => {
      call += 1;
      if (call <= 8) {
        return Promise.reject(uniqueViolation());
      }
      return Promise.resolve({});
    });

    const handle = await assignHandle("user-1");

    expect(prismaMock.user.update).toHaveBeenCalledTimes(9);
    expect(split(handle).suffix).toHaveLength(12);
  });

  it("reicht andere Datenbankfehler unverändert durch", async () => {
    prismaMock.user.update.mockRejectedValue(new Error("connection lost"));

    await expect(assignHandle("user-1")).rejects.toThrow("connection lost");
    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
  });
});
