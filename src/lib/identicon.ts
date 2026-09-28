/**
 * Profilbild als Identicon (27.09.2026, User-Entscheid: Variante «A» mit
 * Akzentfarben, eckig).
 *
 * 5 × 5 Felder, links-rechts gespiegelt, eine Farbe — berechnet aus einem
 * Zufallswert, nie aus Daten der Person. Die Plattform bleibt pseudonym:
 * Es gibt keinen Upload und kein Foto.
 *
 * Bewusst eine reine Funktion mit eigenem Hash statt `node:crypto`: Server
 * und Browser müssen für denselben Seed dasselbe Bild zeichnen (das
 * «Neues Bild» auf dem Profil zeichnet im Client).
 */

/**
 * Akzentfarben. Rot und Grün fehlen absichtlich: Sie bedeuten im Styleguide
 * contra und pro — ein Profilbild darf nicht wie eine Haltung aussehen.
 * Jede Farbe erreicht auf der Fläche (#f3f4f6) mindestens 4.5:1.
 */
export const AVATAR_COLORS = [
  "#141414", // Schwarz (Grundton)
  "#1d4ed8", // Blau
  "#8a5a00", // Ocker
  "#6d28d9", // Violett
  "#0e7490", // Petrol
] as const;

export const AVATAR_BACKGROUND = "#f3f4f6";

/** Spalten 0–2 werden gewürfelt, 3–4 gespiegelt: 5 Zeilen × 3 Spalten. */
const RANDOM_CELLS = 15;
const MIN_FILLED = 4;

/** cyrb53-Variante: zwei unabhängige 32-bit-Hashes aus einem String. */
function hashPair(input: string): [number, number] {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1 >>> 0, h2 >>> 0];
}

function popcount(bits: number): number {
  let count = 0;
  for (let b = bits; b; b &= b - 1) {
    count += 1;
  }
  return count;
}

export type Identicon = {
  color: (typeof AVATAR_COLORS)[number];
  /** 25 Felder, zeilenweise; `true` = gefüllt. */
  cells: boolean[];
};

export function identicon(seed: string): Identicon {
  const [h1, h2] = hashPair(seed);
  const mask = (1 << RANDOM_CELLS) - 1;
  let bits = h1 & mask;
  // Ein fast leeres Bild wäre bei 20 px nicht zu erkennen.
  if (popcount(bits) < MIN_FILLED) {
    bits |= (h2 >>> 8) & mask;
  }
  if (popcount(bits) < MIN_FILLED) {
    bits |= 0b010_101_010_101_010;
  }
  const cells: boolean[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const source = col < 3 ? col : 4 - col;
      cells.push(((bits >>> (row * 3 + source)) & 1) === 1);
    }
  }
  return { color: AVATAR_COLORS[h2 % AVATAR_COLORS.length]!, cells };
}

/** Seed des Bildes: der gespeicherte Zufallswert, sonst die User-Id. */
export function avatarSeedOf(user: {
  id: string;
  avatarSeed: string | null;
}): string {
  return user.avatarSeed ?? user.id;
}
