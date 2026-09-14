import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  checkClientIpRateLimit,
  checkRateLimit,
  getClientIp,
} from "@/lib/rate-limit";
import { verifyTurnstileToken } from "@/lib/turnstile";

// NextAuth v4 App-Router-Handler. POSTs laufen durch einen Guard:
// Rate-Limit (IP, dann E-Mail) → Turnstile → NextAuth (Reihenfolge bewusst:
// billige Checks zuerst, externer siteverify-Call zuletzt).
const handler = NextAuth(authOptions) as (
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> },
) => Promise<Response>;

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
  const ip = getClientIp(req.headers);

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
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();

    const emailLimit = await checkRateLimit({
      scope: "auth-email",
      identifier: email || "empty",
      limit: 5,
      windowSeconds: 900,
    });
    if (!emailLimit.ok) {
      return rejected(req, "RateLimit", 429);
    }

    const token = form.get("cf-turnstile-response");
    const human = await verifyTurnstileToken(
      typeof token === "string" ? token : null,
      ip,
    );
    if (!human) {
      return rejected(req, "Turnstile", 400);
    }
  }

  return handler(req, ctx);
}

export { handler as GET, guardedPost as POST };
