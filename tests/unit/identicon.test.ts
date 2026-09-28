import { describe, expect, it } from "vitest";
import {
  AVATAR_BACKGROUND,
  AVATAR_COLORS,
  avatarSeedOf,
  identicon,
} from "@/lib/identicon";

/**
 * Profilbild als Identicon (27.09.2026): gleiches Bild für denselben Seed
 * auf Server und Client, gespiegelt, nie leer — und keine Farbe, die im
 * Styleguide eine Haltung bedeutet.
 */

const SEEDS = Array.from({ length: 5000 }, (_, i) => `seed-${i}`);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

describe("identicon", () => {
  it("ist deterministisch", () => {
    expect(identicon("brienzersee_k7x2")).toEqual(
      identicon("brienzersee_k7x2"),
    );
  });

  it("ist links-rechts gespiegelt und hat 25 Felder", () => {
    for (const seed of SEEDS.slice(0, 500)) {
      const { cells } = identicon(seed);
      expect(cells).toHaveLength(25);
      for (let row = 0; row < 5; row += 1) {
        expect(cells[row * 5]).toBe(cells[row * 5 + 4]);
        expect(cells[row * 5 + 1]).toBe(cells[row * 5 + 3]);
      }
    }
  });

  it("ist nie fast leer (bei 20 px nicht zu erkennen)", () => {
    for (const seed of SEEDS) {
      const random = identicon(seed).cells.filter(
        (filled, i) => filled && i % 5 < 3,
      ).length;
      expect(random).toBeGreaterThanOrEqual(4);
    }
  });

  it("verteilt Muster und Farben breit", () => {
    const patterns = new Set(SEEDS.map((s) => identicon(s).cells.join("")));
    const colors = new Set(SEEDS.map((s) => identicon(s).color));
    expect(patterns.size).toBeGreaterThan(4000);
    expect(colors.size).toBe(AVATAR_COLORS.length);
  });

  it("nutzt weder Rot (contra) noch Grün (pro) des Styleguides", () => {
    for (const color of AVATAR_COLORS) {
      const [r, g, b] = [1, 3, 5].map((i) =>
        parseInt(color.slice(i, i + 2), 16),
      );
      expect(r! > 150 && g! < 100 && b! < 100, `${color} ist rot`).toBe(false);
      expect(g! > r! + 40 && g! > b! + 40, `${color} ist grün`).toBe(false);
    }
  });

  it("jede Farbe erreicht 4.5:1 auf der Fläche", () => {
    const bg = luminance(AVATAR_BACKGROUND);
    for (const color of AVATAR_COLORS) {
      const ratio = (bg + 0.05) / (luminance(color) + 0.05);
      expect(ratio, color).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("avatarSeedOf", () => {
  it("gespeicherter Wert vor User-Id", () => {
    expect(avatarSeedOf({ id: "u1", avatarSeed: "abc" })).toBe("abc");
    expect(avatarSeedOf({ id: "u1", avatarSeed: null })).toBe("u1");
  });
});
