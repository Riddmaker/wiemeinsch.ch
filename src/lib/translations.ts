import type { Locale as DbLocale } from "@/generated/prisma/client";
import type { AppLocale } from "@/i18n/routing";
import { toAppLocale } from "./locale";

/**
 * Fassung in der Anzeige-Sprache wählen, sonst das Original (P11, DRY).
 *
 * Dieselbe Regel gilt seit P7 für Tickets, Statements und Änderungsanträge:
 * Wer eine Sprache eingestellt hat, liest darin — fehlt die Fassung (Datenfehler
 * oder neue Sprache), fällt die Anzeige auf das Original zurück.
 */
export function pickTranslation<
  T extends { locale: DbLocale; isOriginal: boolean },
>(rows: T[], displayLocale: AppLocale): T | undefined {
  return (
    rows.find((row) => toAppLocale(row.locale) === displayLocale) ??
    rows.find((row) => row.isOriginal)
  );
}
