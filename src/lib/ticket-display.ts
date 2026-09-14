import type { AppLocale } from "@/i18n/routing";

type RegionSource = {
  level: "FEDERAL" | "CANTONAL" | "MUNICIPAL";
  canton: { nameDe: string; nameFr: string; nameIt: string } | null;
  municipality: { name: string } | null;
};

/**
 * Regionsname für den Ebenen-Chip (Styleguide Art. 6) — null bei FEDERAL.
 * Chip-Text = übersetztes Level-Label, bei Region ergänzt um « · <Region>».
 */
export function regionName(
  ticket: RegionSource,
  locale: AppLocale,
): string | null {
  if (ticket.level === "CANTONAL" && ticket.canton) {
    if (locale === "fr") {
      return ticket.canton.nameFr;
    }
    if (locale === "it") {
      return ticket.canton.nameIt;
    }
    return ticket.canton.nameDe;
  }
  if (ticket.level === "MUNICIPAL" && ticket.municipality) {
    return ticket.municipality.name;
  }
  return null;
}
