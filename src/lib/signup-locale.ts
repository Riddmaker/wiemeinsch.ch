import { AsyncLocalStorage } from "node:async_hooks";
import { routing, type AppLocale } from "@/i18n/routing";

/**
 * Sprache eines neu registrierten Kontos (25.09.2026).
 *
 * Befund: Jedes neue Konto bekam die Default-Sprache DE. Seit E11 gilt für
 * Angemeldete aber die Profilsprache überall — wer sich über `/fr/login`
 * registrierte, wurde nach dem Klick auf den Magic Link von `/fr` auf `/de`
 * umgeleitet. Genau beim ersten Eindruck, für die ganze Romandie und das
 * Tessin.
 *
 * NextAuth reicht dem `createUser`-Event nur den User, nicht den Request.
 * Die Auth-Route ermittelt die Sprache deshalb selbst und legt sie für die
 * Dauer des Callbacks in diesen Kontext; `events.createUser` liest sie dort.
 */
export const signupLocaleContext = new AsyncLocalStorage<AppLocale>();

function isAppLocale(value: string | undefined): value is AppLocale {
  return (routing.locales as readonly string[]).includes(value ?? "");
}

/** Erster Pfadabschnitt einer (relativen oder absoluten) URL, falls Locale. */
export function localeFromUrl(
  value: string | null | undefined,
  base: string,
): AppLocale | null {
  if (!value) {
    return null;
  }
  try {
    const segment = new URL(value, base).pathname.split("/")[1];
    return isAppLocale(segment) ? segment : null;
  } catch {
    return null;
  }
}

/** Erste unterstützte Sprache aus `Accept-Language` (nach Gewichtung). */
export function localeFromAcceptLanguage(
  header: string | null | undefined,
): AppLocale | null {
  if (!header) {
    return null;
  }
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((param) => /^q=([\d.]+)$/.exec(param.trim())?.[1])
        .find((value) => value !== undefined);
      return {
        language: tag.toLowerCase().split("-")[0],
        weight: q === undefined ? 1 : Number(q),
        index,
      };
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const match = ranked.find((entry) => isAppLocale(entry.language));
  return match ? (match.language as AppLocale) : null;
}

/**
 * Reihenfolge: `callbackUrl` des Magic Links (steht in der Link-Query, geht
 * also auch in einem anderen Browser mit) → NextAuths Callback-Cookie (für
 * Google, dort gibt es keine Query) → `Accept-Language` → DE.
 */
export function resolveSignupLocale(input: {
  callbackUrl: string | null | undefined;
  callbackCookie: string | null | undefined;
  acceptLanguage: string | null | undefined;
  base: string;
}): AppLocale {
  return (
    localeFromUrl(input.callbackUrl, input.base) ??
    localeFromUrl(input.callbackCookie, input.base) ??
    localeFromAcceptLanguage(input.acceptLanguage) ??
    routing.defaultLocale
  );
}
