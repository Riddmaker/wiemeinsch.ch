import { getServerSession } from "next-auth";
import type { AppLocale } from "@/i18n/routing";
import { authOptions } from "@/lib/auth";

/**
 * Anzeige-Sprache für Inhalte.
 *
 * Seit E11 (04.09.2026) ist das schlicht die Locale im Pfad — für
 * Angemeldete stellt der Layout vorher sicher, dass dort ihre Profilsprache
 * steht (siehe lib/locale-redirect.ts). Vorher las diese Funktion bei JEDEM
 * Seitenaufruf die Profilsprache aus der Datenbank und übersteuerte damit
 * die Route; das erzeugte die halb übersetzte Ansicht und eine zusätzliche
 * Abfrage pro Seite.
 *
 * Liefert die userId weiterhin mit, damit Seiten keine zweite
 * Session-Abfrage brauchen.
 */
export async function getDisplayLocale(routeLocale: AppLocale): Promise<{
  displayLocale: AppLocale;
  userId: string | null;
}> {
  const session = await getServerSession(authOptions);
  return { displayLocale: routeLocale, userId: session?.user?.id ?? null };
}
