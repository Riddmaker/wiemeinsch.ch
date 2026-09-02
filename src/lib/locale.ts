import type { Locale as DbLocale } from "@/generated/prisma/client";
import type { AppLocale } from "@/i18n/routing";

/** App-Locale (next-intl, "de") ⇄ Prisma-Enum (DB, "DE"). */
export function toDbLocale(locale: AppLocale): DbLocale {
  return locale.toUpperCase() as DbLocale;
}

export function toAppLocale(locale: DbLocale): AppLocale {
  return locale.toLowerCase() as AppLocale;
}
