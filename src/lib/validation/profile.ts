import { z } from "./zod";

/**
 * Profil-Schemas (P11.1). Geteilt zwischen Einstellungs-Formular und
 * Server Action (Single Source of Truth).
 *
 * Datenschutz-Grundsatz (nDSG): Alle
 * demografischen Felder sind FREIWILLIG (Entscheid, 30.08.2026). Ein leeres
 * Formularfeld bedeutet «keine Angabe» und wird zu `null` — nicht zu einem
 * leeren String, damit die DB keine Pseudo-Werte sammelt.
 */

/** Untergrenze wie in amtlichen Statistiken; Obergrenze ist das laufende Jahr. */
export const BIRTH_YEAR_MIN = 1900;
export const OCCUPATION_MAX = 100;

export function currentBirthYearMax(now: Date = new Date()): number {
  return now.getFullYear();
}

/** Geschlecht exakt). */
export const genderSchema = z.enum(["M", "F", "D"]);

/** Bildungs-Stufen exakt*/
export const educationSchema = z.enum([
  "OBLIGATORISCHE_SCHULE",
  "BERUFSLEHRE",
  "GYMNASIALE_MATURA",
  "HOEHERE_BERUFSBILDUNG",
  "BACHELOR",
  "MASTER_ODER_HOEHER",
]);

export type Gender = z.output<typeof genderSchema>;
export type Education = z.output<typeof educationSchema>;

export const GENDERS = genderSchema.options;
export const EDUCATION_LEVELS = educationSchema.options;

/** Sprache in DB-Schreibweise (Prisma-Enum) — abgeleitet aus der App-Locale. */
export const dbLocaleSchema = z.enum(["DE", "FR", "IT"]);

/**
 * Leerer String ⇒ «keine Angabe». Das Formular sendet ausschliesslich
 * Strings (native Selects/Inputs), deshalb wird hier normalisiert statt im UI.
 */
function optionalField<T extends z.ZodType>(inner: T) {
  return z.preprocess(
    (value) =>
      value === "" || value === undefined || value === null ? null : value,
    inner.nullable(),
  );
}

const birthYearSchema = z.preprocess(
  (value) => {
    if (value === "" || value === undefined || value === null) {
      return null;
    }
    // Native number-Inputs liefern Strings — hier einmal zentral umwandeln.
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    }
    return value;
  },
  z
    .number()
    .int({ message: "invalid_birth_year" })
    .min(BIRTH_YEAR_MIN, { message: "invalid_birth_year" })
    .refine((year) => year <= currentBirthYearMax(), {
      message: "invalid_birth_year",
    })
    .nullable(),
);

/**
 * Schweizer PLZ: vier Ziffern, führende Null gibt es nicht (1000–9999).
 * Bewusst keine Prüfung gegen ein PLZ-Verzeichnis — das wäre eine zweite
 * Stammdatenquelle neben dem BFS-Snapshot (E7) ohne Sicherheitsgewinn.
 */
const postalCodeSchema = optionalField(
  z
    .string()
    .trim()
    .regex(/^[1-9]\d{3}$/, { message: "invalid_postal_code" }),
);

const occupationSchema = optionalField(
  z
    .string()
    .trim()
    .min(1, { message: "invalid_occupation" })
    .max(OCCUPATION_MAX, { message: `max_${OCCUPATION_MAX}` }),
);

/**
 * Eingabe der Einstellungs-Seite. `strictObject`: Ein zusätzliches Feld (z.B.
 * `isAdmin` aus einem manipulierten Request) lässt die Validierung scheitern,
 * statt still in die Mutation zu wandern.
 */
export const profileSettingsSchema = z.strictObject({
  preferredLocale: dbLocaleSchema,
  birthYear: birthYearSchema,
  gender: optionalField(genderSchema),
  education: optionalField(educationSchema),
  postalCode: postalCodeSchema,
  occupation: occupationSchema,
});

export type ProfileSettingsInput = z.output<typeof profileSettingsSchema>;
