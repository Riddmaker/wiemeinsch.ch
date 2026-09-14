import { notFound } from "next/navigation";

/**
 * Catch-all für unbekannte Adressen (P13.6).
 *
 * Ohne diese Route beantwortet Next unbekannte URLs mit seiner eingebauten
 * 404-Seite — englisch, ausserhalb von Layout und Sprachwahl. `notFound()`
 * hier leitet stattdessen auf `[locale]/not-found.tsx` um, sodass eine
 * unbekannte Adresse und ein `notFound()` aus dem Anwendungscode exakt
 * dieselbe Antwort erzeugen. Das ist nicht nur Kosmetik: Wären beide
 * unterscheidbar, verriete die Antwort, ob eine Route existiert.
 *
 * Bewusst KEIN `experimental.globalNotFound` (Next-Doku → not-found.js): ein
 * experimentelles Flag gehört nicht in eine Härtungsphase.
 */
export default function CatchAllNotFound(): never {
  notFound();
}
