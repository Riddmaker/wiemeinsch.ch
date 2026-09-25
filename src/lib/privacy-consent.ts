import { routing, type AppLocale } from "@/i18n/routing";

/**
 * Einwilligung in die Datenschutzerklärung (25.09.2026).
 *
 * Die Plattform veröffentlicht, wie jemand abstimmt — das kann politische
 * Ansichten zeigen, und die gelten nach DSG als besonders schützenswert.
 * Dafür braucht es eine AUSDRÜCKLICHE Einwilligung (DSG Art. 6 Abs. 7), und
 * wer sie behauptet, muss sie belegen können. Deshalb wird sie nicht als
 * Satz unter dem Login-Formular eingeholt, sondern nach dem Login als
 * eigener Schritt mit Version und Zeitpunkt in der DB gespeichert.
 *
 * Ändert sich die Erklärung wesentlich, wird die Version erhöht: Alle
 * werden beim nächsten Seitenaufruf erneut gefragt. Redaktionelle
 * Korrekturen lassen die Version stehen.
 */
export const PRIVACY_POLICY_VERSION = "2026-09-25";

export function hasCurrentConsent(version: string | null | undefined): boolean {
  return version === PRIVACY_POLICY_VERSION;
}

/**
 * Seiten, die ohne Einwilligung erreichbar bleiben: die Zustimmung selbst
 * und alles, was man lesen muss, um sich zu entscheiden.
 */
const CONSENT_FREE_SEGMENTS = new Set([
  "zustimmung",
  "datenschutz",
  "impressum",
  "faq",
]);

/** Zweiter Pfadabschnitt: `/de/faq?x` → `faq`. */
function pageSegment(path: string): string {
  return (path.split("?")[0] ?? "").split("/")[2] ?? "";
}

/**
 * Zielpfad der Zustimmungsseite, wenn umgeleitet werden muss — sonst `null`.
 * Pfad und Query gehen als `next` mit, damit es nach der Zustimmung dort
 * weitergeht, wo die Person hinwollte.
 */
export function consentRedirectTarget(
  pathname: string,
  search: string,
  locale: AppLocale,
): string | null {
  if (CONSENT_FREE_SEGMENTS.has(pageSegment(pathname))) {
    return null;
  }
  const next = encodeURIComponent(`${pathname}${search}`);
  return `/${locale}/zustimmung?next=${next}`;
}

const LOCAL_PATH = new RegExp(
  `^/(${routing.locales.join("|")})(/[^/?#].*|[?#].*)?$`,
);

/**
 * Backslash und Steuerzeichen: Browser lesen `\` als `/` und entfernen Tabs
 * und Zeilenumbrüche aus URLs — `/\evil.ch` oder `/<Tab>/evil.ch` würde so
 * zu `//evil.ch`.
 */
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

/**
 * `next` aus der Query ist Nutzereingabe: Nur ein eigener, lokalisierter
 * Pfad wird übernommen (Open-Redirect-Schutz, OWASP A01). `//evil.ch`,
 * absolute URLs und Backslash-Tricks landen auf dem Board.
 */
export function safeNextPath(next: unknown, locale: AppLocale): string {
  const fallback = `/${locale}`;
  if (typeof next !== "string" || next.length > 2048) {
    return fallback;
  }
  if (UNSAFE_CHARS.test(next) || !LOCAL_PATH.test(next)) {
    return fallback;
  }
  // Zurück auf die Zustimmung wäre eine Schleife ohne Ausgang.
  if (pageSegment(next) === "zustimmung") {
    return fallback;
  }
  return next;
}
