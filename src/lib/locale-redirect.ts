import { routing, type AppLocale } from "@/i18n/routing";

/**
 * Eine Sprache pro angemeldetem User (Entscheid E11, 04.09.2026).
 *
 * Bis dahin folgte die Oberfläche der Locale im Pfad, der Inhalt aber der
 * Profilsprache. Wer im Header auf «FR» klickte, bekam französische
 * Bedienelemente und deutschen Tickettext — der Umschalter wirkte kaputt,
 * und ausgerechnet nach dem Login wurde die Anwendung schlechter.
 *
 * Neu gilt für Angemeldete überall die Profilsprache: Ein geteilter
 * `/fr`-Link leitet den DE-Nutzer auf `/de` um. Die Locale im Pfad ist für
 * ihn damit wirkungslos — bewusst in Kauf genommen (User-Entscheid), weil
 * eine Sprache pro Sitzung erklärbarer ist als zwei nebeneinander.
 *
 * Reine Funktion, damit die Schleifenfreiheit ohne Browser prüfbar ist.
 */

/** Erster Pfadabschnitt, sofern er eine bekannte Locale ist. */
function localeOf(pathname: string): AppLocale | null {
  const first = pathname.split("/")[1] ?? "";
  return (routing.locales as readonly string[]).includes(first)
    ? (first as AppLocale)
    : null;
}

/**
 * Zielpfad, wenn umgeleitet werden muss — sonst `null`.
 *
 * `null` immer dann, wenn schon die richtige Locale im Pfad steht; damit
 * kann die Umleitung sich nicht selbst erneut auslösen.
 */
export function localeRedirectTarget(
  pathname: string,
  profileLocale: AppLocale,
): string | null {
  const current = localeOf(pathname);
  if (current === null || current === profileLocale) {
    return null;
  }
  const rest = pathname.slice(`/${current}`.length);
  return `/${profileLocale}${rest}`;
}
