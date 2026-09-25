/**
 * Datumsformat der Plattform (Code-Review 25.09.2026).
 *
 * Vorher formatierte jede Seite mit `new Intl.DateTimeFormat(…)` in der
 * Zeitzone des Servers — im Container UTC. Ein Ticket von 00:30 Schweizer
 * Zeit trug so das Datum des Vortags. Die Zeitzone ist fest: Die Plattform
 * ist schweizerisch, und Server wie Browser sollen dasselbe Datum zeigen.
 */
export const APP_TIME_ZONE = "Europe/Zurich";

export function dateFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(`${locale}-CH`, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: APP_TIME_ZONE,
  });
}
