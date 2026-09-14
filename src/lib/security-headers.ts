/**
 * Security-Header (P13.2) — zentral gebaut, damit Proxy und Tests dieselbe
 * Quelle benutzen (OWASP Top 10 2025:
 * A02 Security Misconfiguration, A03 Injection/XSS).
 *
 * CSP-Strategie (User-Entscheid 31.08.2026): Nonce + `strict-dynamic`, also
 * KEIN `'unsafe-inline'` für Skripte. Der Preis steht in der Next-Doku
 * (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`):
 * Ein Nonce wird beim Server-Rendering aus dem Request-Header gelesen, also
 * müssen alle Seiten dynamisch gerendert werden — statisches Prerendering und
 * ISR entfallen. Bei einer datenbankgetriebenen App ist das vertretbar.
 */

/** Turnstile lädt sein Script und sein Widget-Iframe von dieser Origin (E6). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export type SecurityContext = {
  /** `next dev`: React nutzt `eval` für Server-Stacks im Browser. */
  isDev: boolean;
  /** Läuft die App hinter TLS? Steuert HSTS und `upgrade-insecure-requests`. */
  isHttps: boolean;
};

/**
 * Erzeugt einen Nonce pro Request. `crypto.randomUUID()` ist im Edge- wie im
 * Node-Runtime verfügbar und kryptografisch zufällig — ein ratbarer Nonce
 * wäre wertlos.
 */
export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildContentSecurityPolicy(
  nonce: string,
  { isDev, isHttps }: SecurityContext,
): string {
  const directives: string[] = [
    "default-src 'self'",
    // `strict-dynamic` erlaubt genau die Skripte, die ein bereits
    // vertrauenswürdiges (genonctes) Skript nachlädt — damit ist Turnstile
    // abgedeckt, ohne Inline-Skripte zu öffnen. Die Host-Angabe daneben ist
    // der Fallback für Browser ohne `strict-dynamic`-Unterstützung.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE_ORIGIN}${
      isDev ? " 'unsafe-eval'" : ""
    }`,
    // Stylesheets kommen als Dateien aus /_next/static.
    //
    // Im Dev-Modus steht hier BEWUSST kein Nonce: das next-devtools-Overlay
    // injiziert laufend Inline-<style>-Elemente ohne Nonce, und ein Nonce in
    // der Direktive lässt den Browser 'unsafe-inline' ignorieren (empirisch
    // in P13.2 gemessen: ~30 style-src-elem-Violations pro Seitenaufruf, alle
    // aus next-devtools). Eine Konsole voller Fremd-Violations verdeckt echte
    // Befunde. In Produktion existiert das Overlay nicht — dort gilt der
    // Nonce ohne Ausnahme.
    isDev
      ? "style-src 'self' 'unsafe-inline'"
      : `style-src 'self' 'nonce-${nonce}'`,
    // style-ATTRIBUTE getrennt freigeben: React schreibt `style={{…}}` als
    // Attribut ins SSR-HTML (Fortschrittsbalken im Editor). Ein Attribut kann
    // kein Skript ausführen — der XSS-Schutz von `script-src` bleibt intakt.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    // next/font/google hostet die Schriften zur Build-Zeit selbst.
    "font-src 'self'",
    `connect-src 'self' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Clickjacking-Schutz (moderner Ersatz für X-Frame-Options).
    "frame-ancestors 'none'",
  ];

  if (isHttps) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

/**
 * Alle Header ausser der CSP — die braucht den Nonce und wird separat gesetzt.
 */
export function staticSecurityHeaders({
  isHttps,
}: SecurityContext): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Legacy-Doppelung zu `frame-ancestors` für ältere Browser.
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    // Die App braucht keine dieser Geräte-APIs (Principle of Least Privilege).
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  };

  if (isHttps) {
    // Zwei Jahre, Subdomains eingeschlossen — Voraussetzung für die
    // Preload-Liste.
    headers["Strict-Transport-Security"] =
      "max-age=63072000; includeSubDomains; preload";
  }

  return headers;
}

/** Kontext aus den Prozess-Variablen — an einer Stelle, nicht verstreut. */
export function securityContext(): SecurityContext {
  return {
    isDev: process.env.NODE_ENV === "development",
    // Lokal läuft die App über http; TLS terminiert in Prod der Tunnel.
    isHttps: process.env.TRUST_PROXY === "true",
  };
}
