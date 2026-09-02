import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Profil-Einstellungen (P11.2, T11-Bypass-Tests): Reihenfolge
 * Auth → Rate-Limit → Zod → Mutation, die Grenzen der Demografie-Felder auch
 * bei umgangenem Client, «keine Angabe» ⇒ `null` und — sicherheitsrelevant —
 * dass die Mutation ausschliesslich die sechs erlaubten Spalten des EIGENEN
 * Users schreibt (kein `isAdmin`, keine fremde `id`). DB ist gemockt.
 */

const requireUserMock = vi.fn();
vi.mock("@/lib/require-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/require-user")>();
  return { ...actual, requireUser: () => requireUserMock() };
});

const checkRateLimitMock = vi.fn();
const checkAiBudgetMock = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (opts: unknown) => checkRateLimitMock(opts),
  // Zweite Limit-Schicht der AI-Endpunkte (P13.3).
  checkAiBudget: () => checkAiBudgetMock(),
  checkClientIpRateLimit: () => checkAiBudgetMock(),
  getClientIp: () => "direct",
  UNTRUSTED_CLIENT_IP: "direct",
  AI_IP_BUDGET: { scope: "ai-ip", limit: 60, windowSeconds: 3600 },
}));

const prismaMock = vi.hoisted(() => ({
  user: { update: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateProfile } from "@/actions/profile";
import { UnauthorizedError } from "@/lib/require-user";
import {
  BIRTH_YEAR_MIN,
  currentBirthYearMax,
  OCCUPATION_MAX,
  profileSettingsSchema,
} from "@/lib/validation/profile";

const VALID = {
  preferredLocale: "FR",
  birthYear: "1984",
  gender: "F",
  education: "MASTER_ODER_HOEHER",
  postalCode: "8006",
  occupation: "Verkehrsplanerin",
};

function updateData(): Record<string, unknown> {
  const call = prismaMock.user.update.mock.calls[0]?.[0] as {
    data: Record<string, unknown>;
  };
  return call.data;
}

describe("updateProfile (P11.2)", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    checkRateLimitMock.mockReset();
    prismaMock.user.update.mockReset();
    requireUserMock.mockResolvedValue({ id: "user-1" });
    checkRateLimitMock.mockResolvedValue({ ok: true });
    checkAiBudgetMock.mockResolvedValue({ ok: true });
    prismaMock.user.update.mockResolvedValue({ id: "user-1" });
  });

  it("ohne Session: unauthorized, keine Mutation und kein Rate-Limit-Verbrauch", async () => {
    requireUserMock.mockRejectedValue(new UnauthorizedError());
    const result = await updateProfile(VALID);
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("Rate-Limit greift VOR der Validierung", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });
    const result = await updateProfile({ nonsense: true });
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("schreibt die validierten Werte des eingeloggten Users", async () => {
    const result = await updateProfile(VALID);
    expect(result).toEqual({ ok: true });
    const call = prismaMock.user.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "user-1" });
    expect(call.data).toEqual({
      preferredLocale: "FR",
      birthYear: 1984,
      gender: "F",
      education: "MASTER_ODER_HOEHER",
      postalCode: "8006",
      occupation: "Verkehrsplanerin",
    });
  });

  it("schreibt NUR die sechs erlaubten Spalten (kein isAdmin, keine fremde id)", async () => {
    await updateProfile({
      ...VALID,
      isAdmin: true,
      id: "user-2",
      handle: "geklaut",
    });
    // strictObject lehnt Zusatzfelder ab — es darf gar nicht erst mutiert werden.
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("leere Felder bedeuten «keine Angabe» und werden zu null", async () => {
    const result = await updateProfile({
      preferredLocale: "DE",
      birthYear: "",
      gender: "",
      education: "",
      postalCode: "",
      occupation: "",
    });
    expect(result).toEqual({ ok: true });
    expect(updateData()).toEqual({
      preferredLocale: "DE",
      birthYear: null,
      gender: null,
      education: null,
      postalCode: null,
      occupation: null,
    });
  });

  it("trimmt Beruf und PLZ, bevor sie gespeichert werden", async () => {
    await updateProfile({
      ...VALID,
      postalCode: " 3011 ",
      occupation: "  Gärtner  ",
    });
    expect(updateData()).toMatchObject({
      postalCode: "3011",
      occupation: "Gärtner",
    });
  });

  const invalidInputs: [string, Record<string, unknown>][] = [
    ["Jahrgang vor 1900", { ...VALID, birthYear: "1899" }],
    [
      "Jahrgang in der Zukunft",
      { ...VALID, birthYear: String(currentBirthYearMax() + 1) },
    ],
    ["Jahrgang keine Zahl", { ...VALID, birthYear: "neunzehn" }],
    ["PLZ mit führender Null", { ...VALID, postalCode: "0815" }],
    ["PLZ dreistellig", { ...VALID, postalCode: "123" }],
    ["PLZ fünfstellig", { ...VALID, postalCode: "80061" }],
    ["Beruf zu lang", { ...VALID, occupation: "a".repeat(OCCUPATION_MAX + 1) }],
    ["unbekanntes Geschlecht", { ...VALID, gender: "X" }],
    ["unbekannte Bildungsstufe", { ...VALID, education: "DOKTORAT" }],
    ["unbekannte Sprache", { ...VALID, preferredLocale: "EN" }],
    ["Sprache fehlt", { birthYear: "1984" }],
  ];

  for (const [label, input] of invalidInputs) {
    it(`lehnt ab: ${label} — ohne Mutation`, async () => {
      const result = await updateProfile(input);
      expect(result).toEqual({ ok: false, error: "invalid_input" });
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });
  }
});

describe("profileSettingsSchema — Grenzwerte (P11.1)", () => {
  const base = { preferredLocale: "DE" as const };

  it("akzeptiert die Grenzjahrgänge 1900 und das laufende Jahr", () => {
    for (const year of [BIRTH_YEAR_MIN, currentBirthYearMax()]) {
      const parsed = profileSettingsSchema.safeParse({
        ...base,
        birthYear: year,
      });
      expect(parsed.success, `Jahrgang ${year}`).toBe(true);
    }
  });

  it("akzeptiert PLZ 1000 und 9999, nicht 0999 oder 10000", () => {
    for (const [plz, expected] of [
      ["1000", true],
      ["9999", true],
      ["0999", false],
      ["10000", false],
    ] as const) {
      const parsed = profileSettingsSchema.safeParse({
        ...base,
        postalCode: plz,
      });
      expect(parsed.success, `PLZ ${plz}`).toBe(expected);
    }
  });

  it(`akzeptiert Beruf mit ${OCCUPATION_MAX} Zeichen, nicht mit einem mehr`, () => {
    expect(
      profileSettingsSchema.safeParse({
        ...base,
        occupation: "a".repeat(OCCUPATION_MAX),
      }).success,
    ).toBe(true);
    expect(
      profileSettingsSchema.safeParse({
        ...base,
        occupation: "a".repeat(OCCUPATION_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("fehlende Demografie-Felder sind erlaubt (alles freiwillig)", () => {
    const parsed = profileSettingsSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        preferredLocale: "DE",
        birthYear: null,
        gender: null,
        education: null,
        postalCode: null,
        occupation: null,
      });
    }
  });
});
