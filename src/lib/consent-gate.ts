import type { NextRequest } from "next/server";
import { routing } from "@/i18n/routing";
import { toAppLocale } from "@/lib/locale";
import { errorFields, logEvent } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import {
  consentRedirectTarget,
  hasCurrentConsent,
} from "@/lib/privacy-consent";

/**
 * Einwilligungs-Gate im Proxy (27.09.2026).
 *
 * Bis dahin prüfte das Locale-Layout. Layouts rendern bei Navigationen im
 * Browser aber nicht neu (Next-Doku: layout.md «Caveats», authentication.md
 * «Layouts and auth checks») — beim ersten echten Login in Produktion führte
 * ein Klick auf den eigenen @handle im Header an der Zustimmung vorbei. Der
 * Proxy läuft bei jeder Anfrage, auch bei den RSC-Anfragen einer
 * Client-Navigation.
 *
 * Das ist die Umleitung für die Oberfläche; die Absicherung bleibt
 * `requireUser` (ConsentRequiredError) in jeder Action.
 */

/** NextAuths Session-Cookie — mit Präfix, sobald `NEXTAUTH_URL` https ist. */
export const SESSION_COOKIES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

const LOCALES: ReadonlySet<string> = new Set(routing.locales);

/**
 * Nur Pfade mit Locale werden geprüft: `/` oder `/tickets` leitet next-intl
 * zuerst auf `/de/…` um, und diese Anfrage kommt dann hier vorbei.
 */
function hasLocalePrefix(pathname: string): boolean {
  return LOCALES.has(pathname.split("/")[1] ?? "");
}

/**
 * Ziel der Umleitung auf die Zustimmung — oder `null`. Die DB wird nur
 * gefragt, wenn ein Session-Cookie da ist: Gäste kosten nichts, Angemeldete
 * eine Abfrage über den eindeutigen Session-Token.
 */
export async function consentGateTarget(
  request: NextRequest,
): Promise<string | null> {
  const token = SESSION_COOKIES.map(
    (name) => request.cookies.get(name)?.value,
  ).find(Boolean);
  const { pathname, search } = request.nextUrl;
  if (!token || !hasLocalePrefix(pathname)) {
    return null;
  }

  let user: {
    preferredLocale: Parameters<typeof toAppLocale>[0];
    privacyConsentVersion: string | null;
  } | null;
  try {
    const session = await prisma.session.findUnique({
      where: { sessionToken: token },
      select: {
        expires: true,
        user: {
          select: { preferredLocale: true, privacyConsentVersion: true },
        },
      },
    });
    // Abgelaufen = Gast, wie getServerSession es sieht.
    user = session && session.expires > new Date() ? session.user : null;
  } catch (error) {
    // Offen scheitern: Die Seite selbst braucht die DB ohnehin, und ohne
    // Einwilligung veröffentlicht requireUser trotzdem nichts.
    logEvent("error", "consent_gate_lookup_failed", errorFields(error));
    return null;
  }

  if (!user || hasCurrentConsent(user.privacyConsentVersion)) {
    return null;
  }
  // In der Profilsprache (E11), wie alle Umleitungen für Angemeldete.
  return consentRedirectTarget(
    pathname,
    search,
    toAppLocale(user.preferredLocale),
  );
}
