import type { Page } from "@playwright/test";

/**
 * Geteilte E2E-Helfer (P8, DRY): Magic-Link-Login gegen die lokale
 * Compose-Instanz (App :3000, Mailpit :8025) — Muster aus auth.spec.ts.
 */

const MAILPIT = "http://localhost:8025";

export async function fetchMagicLink(
  page: Page,
  email: string,
  /**
   * Nur Mails ab diesem Zeitpunkt akzeptieren (ms). Ohne die Schranke könnte
   * bei fixen Adressen (P10-Rollen) ein bereits verbrauchter Link aus einem
   * früheren Lauf gezogen werden — der Callback endet dann in
   * `login/error?error=Verification` und der Test läuft ohne Session weiter.
   */
  notBefore = 0,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = await page.request.get(`${MAILPIT}/api/v1/messages?limit=20`);
    const data = (await list.json()) as {
      messages?: { ID: string; Created?: string; To?: { Address: string }[] }[];
    };
    const msg = data.messages?.find(
      (m) =>
        m.To?.some((to) => to.Address.toLowerCase() === email.toLowerCase()) &&
        (!m.Created || new Date(m.Created).getTime() >= notBefore),
    );
    if (msg) {
      const detail = await page.request.get(
        `${MAILPIT}/api/v1/message/${msg.ID}`,
      );
      const body = (await detail.json()) as { Text?: string; HTML?: string };
      const haystack = `${body.Text ?? ""}\n${body.HTML ?? ""}`;
      const match = haystack.match(
        /http:\/\/localhost:3000\/api\/auth\/callback\/email[^\s"'<>\]]+/,
      );
      if (match) return match[0].replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Keine Magic-Link-Mail für ${email} in Mailpit gefunden`);
}

/** Login via Magic-Link mit frischer Wegwerf-Adresse (ohne UI-Umweg). */
export async function login(page: Page, emailPrefix = "e2e"): Promise<void> {
  const email = `${emailPrefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@example.com`;
  await loginAs(page, email);
}

/**
 * Login als bestehender User mit fixer Adresse (P10): Rollen-Tests brauchen
 * eine bekannte Identität — der Seed gibt `seed-user-1/-2` E-Mail-Adressen,
 * damit sich der Original-Autor eines Seed-Tickets anmelden kann.
 */
export async function loginAs(page: Page, email: string): Promise<void> {
  const requestedAt = Date.now();
  const { csrfToken } = (await (
    await page.request.get("/api/auth/csrf")
  ).json()) as { csrfToken: string };
  const response = await page.request.post("/api/auth/signin/email", {
    form: {
      csrfToken,
      email,
      callbackUrl: "/de",
      "cf-turnstile-response": "e2e-dummy-token",
    },
  });
  if (!response.ok()) {
    // Bei 429 greift das Limit von 5 Magic-Links pro Adresse und 15 Minuten
    // (P4) — sonst liefe der Test ohne Session in einen Timeout.
    throw new Error(
      `Magic-Link-Anforderung für ${email} fehlgeschlagen: HTTP ${response.status()}`,
    );
  }
  const link = await fetchMagicLink(page, email, requestedAt);
  await page.goto(link);
  await page.waitForURL("http://localhost:3000/**");
  // Ein verbrauchter oder manipulierter Link landet auf der Fehlerseite —
  // das darf nicht still als «eingeloggt» durchgehen.
  if (page.url().includes("/login/error")) {
    throw new Error(`Magic-Link für ${email} wurde nicht akzeptiert`);
  }
}
