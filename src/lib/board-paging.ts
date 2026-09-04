/**
 * Board-Pagination (04.09.2026).
 *
 * Vorher lud das Board hart die ersten 50 Tickets und bot keinen Weg zu den
 * übrigen — ein Anliegen auf Rang 51 war öffentlich nicht mehr erreichbar.
 * Das widerspricht dem Zweck der Plattform, Themen sichtbar zu machen.
 *
 * Umgesetzt als URL-Parameter statt als clientseitiges Nachladen: Der Stand
 * ist teilbar, von Suchmaschinen indexierbar und funktioniert ohne
 * JavaScript. Der «Weitere laden»-Link navigiert mit `scroll={false}`, die
 * Leseposition bleibt also erhalten — es fühlt sich an wie Nachladen.
 */

/** Tickets pro Seite. */
export const BOARD_PAGE_SIZE = 20;

/**
 * Obergrenze — ohne sie könnte `?seiten=999999` beliebig grosse Abfragen
 * auslösen (Ressourcenerschöpfung über einen ungeprüften Query-Parameter,
 * OWASP A04). 25 Seiten = 500 Tickets.
 */
export const BOARD_MAX_PAGES = 25;

/**
 * Liest den `seiten`-Parameter defensiv: alles Ungültige (Text, Komma,
 * negativ, Vorzeichen, zu gross) fällt auf einen gültigen Wert zurück,
 * statt einen Fehler zu erzeugen.
 */
export function parseBoardPages(raw: string | string[] | undefined): number {
  const value = typeof raw === "string" ? raw : undefined;
  if (value === undefined || !/^\d+$/.test(value)) {
    return 1;
  }
  // Sehr lange Ziffernfolgen vor `parseInt` abfangen: Sie werden sonst zu
  // einer unpräzisen Gleitkommazahl. Ab 7 Stellen liegt der Wert ohnehin
  // über dem Deckel — deckeln statt auf Seite 1 zurückfallen, sonst
  // verhielte sich «999999» anders als eine noch grössere Zahl.
  if (value.length > 6) {
    return BOARD_MAX_PAGES;
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    return 1;
  }
  return Math.min(parsed, BOARD_MAX_PAGES);
}

/** Wie viele Zeilen die Abfrage holt: eine mehr, um «gibt es noch?» zu wissen. */
export function boardFetchSize(pages: number): number {
  return pages * BOARD_PAGE_SIZE + 1;
}
