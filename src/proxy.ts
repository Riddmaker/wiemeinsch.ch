import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import {
  buildContentSecurityPolicy,
  createNonce,
  securityContext,
  staticSecurityHeaders,
} from "./lib/security-headers";

// Next 16: `proxy.ts` ersetzt das deprecatede `middleware.ts` (gleiche Funktion).
const intlMiddleware = createMiddleware(routing);

/**
 * Ein Durchgang, zwei Aufgaben (P13.2):
 *   1. Locale-Routing (next-intl, seit P3).
 *   2. Security-Header inkl. Nonce-basierter CSP.
 *
 * Reihenfolge ist wesentlich: Der Nonce muss VOR dem Rendern in den
 * REQUEST-Headern stehen, weil Next ihn beim Server-Rendering aus dem
 * `Content-Security-Policy`-Request-Header ausliest und selbstständig an
 * Framework-Skripte hängt. next-intl kopiert die Request-Header (`new
 * Headers(request.headers)`) in seine Rewrite-/Next-Response und reicht sie
 * damit weiter — deshalb wird hier zuerst der Request bestückt und erst
 * danach die Middleware aufgerufen.
 */
export default function proxy(request: NextRequest) {
  const context = securityContext();
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(nonce, context);

  request.headers.set("x-nonce", nonce);
  request.headers.set("content-security-policy", csp);

  const response = intlMiddleware(request);

  // Auch Redirects (z.B. `/` → `/de`) tragen die Header — eine Antwort ohne
  // Schutz-Header gibt es nicht.
  response.headers.set("Content-Security-Policy", csp);
  for (const [name, value] of Object.entries(staticSecurityHeaders(context))) {
    response.headers.set(name, value);
  }

  return response;
}

export const config = {
  // Alles ausser API-Routen, Next-Interna und Dateien mit Endung — unverändert
  // seit P3. Die Next-Doku schlägt zusätzlich vor, Prefetches von `next/link`
  // auszunehmen; das wird hier BEWUSST NICHT gemacht: derselbe Matcher steuert
  // auch das Locale-Routing von next-intl, und eine Anfrage ohne dieses
  // Routing wäre ein Verhaltensunterschied zwischen Prefetch und Navigation.
  // Der Preis ist ein zusätzlich erzeugter Nonce pro Prefetch.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
