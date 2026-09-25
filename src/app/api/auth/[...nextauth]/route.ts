import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import { checkClientIpRateLimit, getClientIp } from "@/lib/rate-limit";
import { resolveSignupLocale, signupLocaleContext } from "@/lib/signup-locale";
import { verifyTurnstileToken } from "@/lib/turnstile";

// NextAuth v4 App-Router-Handler.
//
// POST läuft durch einen Guard: IP-Limit → Turnstile → NextAuth. Das Limit
// pro Adresse zählt NICHT hier, sondern im `signIn`-Callback (lib/auth.ts):
// erst nach der CSRF-Prüfung von NextAuth und auf genau die normalisierte
// Adresse, an die gemailt wird.
//
// GET (Callbacks von Magic Link und Google) legt die Sprache der Anmeldung
// in einen Kontext, den `events.createUser` liest (lib/signup-locale.ts).
const handler = NextAuth(authOptions) as (
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> },
) => Promise<Response>;

/** NextAuths Callback-Cookie — mit Präfix, sobald `NEXTAUTH_URL` https ist. */
const CALLBACK_COOKIES = [
  "__Secure-next-auth.callback-url",
  "next-auth.callback-url",
];

function rejected(
  req: NextRequest,
  errorCode: string,
  status: number,
): Response {
  // Browser-Formulare bekommen die lokalisierte Fehlerseite, Skripte den Statuscode.
  if (req.headers.get("accept")?.includes("text/html")) {
    return Response.redirect(
      new URL(`/login/error?error=${errorCode}`, req.url),
      303,
    );
  }
  return Response.json({ error: errorCode }, { status });
}

async function guardedPost(
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> },
): Promise<Response> {
  const { nextauth } = await ctx.params;

  // Nur wirksam hinter einem vertrauenswürdigen Proxy (P13.3): ohne
  // Cloudflare gäbe es keine belastbare Client-IP, und ein gemeinsamer
  // Sentinel-Bucket würde lokal alle Logins zusammen aussperren.
  const ipLimit = await checkClientIpRateLimit(req.headers, {
    scope: "auth-ip",
    limit: 30,
    windowSeconds: 900,
  });
  if (!ipLimit.ok) {
    return rejected(req, "RateLimit", 429);
  }

  if (nextauth[0] === "signin" && nextauth[1] === "email") {
    const form = await req.clone().formData();
    const token = form.get("cf-turnstile-response");
    const human = await verifyTurnstileToken(
      typeof token === "string" ? token : null,
      getClientIp(req.headers),
    );
    if (!human) {
      return rejected(req, "Turnstile", 400);
    }
  }

  return handler(req, ctx);
}

async function localizedGet(
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> },
): Promise<Response> {
  const callbackCookie = CALLBACK_COOKIES.map(
    (name) => req.cookies.get(name)?.value,
  ).find(Boolean);
  const locale = resolveSignupLocale({
    callbackUrl: req.nextUrl.searchParams.get("callbackUrl"),
    callbackCookie,
    acceptLanguage: req.headers.get("accept-language"),
    base: req.url,
  });
  return signupLocaleContext.run(locale, () => handler(req, ctx));
}

export { localizedGet as GET, guardedPost as POST };
