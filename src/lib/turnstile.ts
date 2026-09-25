import { errorFields, logEvent } from "@/lib/log";

/**
 * Cloudflare-Turnstile-Verifikation (Entscheid E6). Fail-closed: ohne Secret,
 * ohne Token oder bei API-Fehler wird NICHT durchgelassen.
 */
const SITEVERIFY_TIMEOUT_MS = 10_000;

export async function verifyTurnstileToken(
  token: string | null,
  remoteIp?: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Konfigurationsfehler: Ohne Secret scheitert JEDER Login — das muss im
    // Log stehen, nicht nur als «Sicherheitsprüfung fehlgeschlagen» im UI.
    logEvent("error", "turnstile.no_secret");
    return false;
  }
  if (!token) {
    return false;
  }

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp && remoteIp !== "direct" && remoteIp !== "unknown") {
      body.set("remoteip", remoteIp);
    }
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        // Ohne Frist hinge der Login an einem langsamen siteverify fest;
        // eine Zeitüberschreitung gilt wie jeder Fehler als «nicht bestanden».
        signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      logEvent("warn", "turnstile.http_error", { httpStatus: res.status });
      return false;
    }
    const data: unknown = await res.json();
    return (
      typeof data === "object" &&
      data !== null &&
      (data as { success?: unknown }).success === true
    );
  } catch (error) {
    logEvent("warn", "turnstile.unreachable", errorFields(error));
    return false;
  }
}
