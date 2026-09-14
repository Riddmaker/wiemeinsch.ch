/**
 * Cloudflare-Turnstile-Verifikation (Entscheid E6). Fail-closed: ohne Secret,
 * ohne Token oder bei API-Fehler wird NICHT durchgelassen.
 */
export async function verifyTurnstileToken(
  token: string | null,
  remoteIp?: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !token) {
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
      },
    );
    if (!res.ok) {
      return false;
    }
    const data: unknown = await res.json();
    return (
      typeof data === "object" &&
      data !== null &&
      (data as { success?: unknown }).success === true
    );
  } catch {
    return false;
  }
}
