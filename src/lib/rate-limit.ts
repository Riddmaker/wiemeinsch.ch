import { prisma } from "@/lib/prisma";

/**
 * Applikationsseitiges Rate-Limiting (Entscheid E2: PostgreSQL, Fixed-Window).
 * In Prod wirkt zusätzlich Cloudflare-Edge-Rate-Limiting als äussere Schicht
 * — nie als Ersatz.
 */

const CLEANUP_PROBABILITY = 0.02;
const CLEANUP_OLDER_THAN_MS = 60 * 60 * 1000;

export type RateLimitResult =
  { ok: true } | { ok: false; retryAfterSeconds: number };

export async function checkRateLimit(opts: {
  scope: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
}): Promise<RateLimitResult> {
  const { scope, identifier, limit, windowSeconds } = opts;
  const key = `${scope}:${identifier}`;
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

  const bucket = await prisma.rateLimitBucket.upsert({
    where: { key_windowStart: { key, windowStart } },
    create: { key, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });

  if (Math.random() < CLEANUP_PROBABILITY) {
    // Opportunistisches Aufräumen alter Fenster — kein Cron nötig (80/20).
    await prisma.rateLimitBucket.deleteMany({
      where: {
        windowStart: { lt: new Date(Date.now() - CLEANUP_OLDER_THAN_MS) },
      },
    });
  }

  if (bucket.count > limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000),
    );
    return { ok: false, retryAfterSeconds };
  }
  return { ok: true };
}

/**
 * Sentinel von `getClientIp`, wenn kein vertrauenswürdiger Proxy davor steht.
 * Bewusst KEINE echte Adresse: ohne Cloudflare ist jeder IP-Header fälschbar.
 */
export const UNTRUSTED_CLIENT_IP = "direct";

/**
 * Client-IP: Proxy-Header (CF-Connecting-IP / X-Forwarded-For) werden NUR
 * hinter Cloudflare gelesen (TRUST_PROXY=true in Prod; lokal false, da lokal kein
 * cloudflared davorsteht).
 */
export function getClientIp(headers: Headers): string {
  if (process.env.TRUST_PROXY === "true") {
    return (
      headers.get("cf-connecting-ip") ??
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown"
    );
  }
  return UNTRUSTED_CLIENT_IP;
}

/**
 * IP-weites Limit als ZWEITE Schicht neben dem User-Limit (P13.3). Nötig,
 * weil ein User-Limit mit beliebig vielen Wegwerf-Accounts umgangen werden
 * kann — bei den AI-Endpunkten kostet das echtes Geld (OWASP GenAI:
 * Unbounded Consumption).
 *
 * Ohne vertrauenswürdigen Proxy (`TRUST_PROXY!=true`, also lokal) wird die
 * Schicht ÜBERSPRUNGEN statt auf einen gemeinsamen Sentinel-Bucket zu zählen:
 * ein geteilter Bucket schützt niemanden und sperrt statt eines Angreifers
 * schlicht alle gleichzeitig aus. Das User-Limit greift unverändert.
 */
export async function checkClientIpRateLimit(
  headers: Headers,
  opts: { scope: string; limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const ip = getClientIp(headers);
  if (ip === UNTRUSTED_CLIENT_IP) {
    return { ok: true };
  }
  return checkRateLimit({ ...opts, identifier: ip });
}

/**
 * Gemeinsames Kostenbudget aller AI-gestützten Actions pro IP. Ein Scope für
 * alle, damit sich das Budget nicht durch Wechseln des Endpunkts vervielfacht.
 */
export const AI_IP_BUDGET = { scope: "ai-ip", limit: 60, windowSeconds: 3600 };

/**
 * Bequemer Aufruf für Server Actions: liest die Request-Header selbst.
 * `next/headers` wird erst beim Aufruf geladen, damit dieses Modul auch
 * ausserhalb eines Request-Kontexts (Unit-Tests) importierbar bleibt.
 */
export async function checkAiBudget(): Promise<RateLimitResult> {
  const { headers } = await import("next/headers");
  return checkClientIpRateLimit(await headers(), AI_IP_BUDGET);
}
