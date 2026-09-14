import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import {
  securityContext,
  staticSecurityHeaders,
} from "./src/lib/security-headers";

/**
 * Die Seiten-Header setzt `src/proxy.ts` (sie brauchen einen Nonce pro
 * Request). Der Matcher des Proxys nimmt `/api` bewusst aus — API-Antworten
 * würden sonst ganz ohne Schutz-Header ausgeliefert. Deshalb hier die
 * nonce-freie Variante für genau diese Routen (P13.2, Defense in Depth).
 */
const apiHeaders = [
  ...Object.entries(staticSecurityHeaders(securityContext())).map(
    ([key, value]) => ({ key, value }),
  ),
  {
    // Eine JSON-Antwort darf gar nichts laden oder eingebettet werden.
    key: "Content-Security-Policy",
    value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  },
];

const nextConfig: NextConfig = {
  // Minimaler Server-Output für das Docker-Runner-Image.
  output: "standalone",
  // Verrät sonst die eingesetzte Framework-Version (Information Disclosure).
  poweredByHeader: false,
  async headers() {
    return [{ source: "/api/:path*", headers: apiHeaders }];
  },
};

// Bindet src/i18n/request.ts als Request-Konfiguration ein (next-intl 4).
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
