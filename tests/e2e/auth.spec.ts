import { expect, test } from "@playwright/test";

/**
 * E2E-Auth-Tests (T4) — laufen gegen die lokale Compose-Instanz
 * (App :3000, Mailpit-API :8025). Turnstile nutzt die Cloudflare-Dummy-Keys
 * (jedes Token besteht siteverify).
 */
const MAILPIT = "http://localhost:8025";

// Die Flow-Tests sind layoutunabhängig — nur im chromium-Projekt ausführen,
// damit Wiederholungen nicht unnötig Rate-Limit-Budget verbrauchen.
const flowOnly = () =>
  test.skip(test.info().project.name !== "chromium", "Flow-Test: nur chromium");

async function fetchMagicLink(
  request: import("@playwright/test").APIRequestContext,
  email: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = await request.get(`${MAILPIT}/api/v1/messages?limit=20`);
    const data = (await list.json()) as {
      messages?: { ID: string; To?: { Address: string }[] }[];
    };
    const msg = data.messages?.find((m) =>
      m.To?.some((to) => to.Address.toLowerCase() === email.toLowerCase()),
    );
    if (msg) {
      const detail = await request.get(`${MAILPIT}/api/v1/message/${msg.ID}`);
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

test("Magic-Link Happy Path — böse callbackUrl wird normalisiert", async ({
  page,
  request,
}) => {
  flowOnly();
  const email = `e2e-happy-${Date.now()}@example.com`;

  await page.goto("/de/login");
  await page.fill('input[name="email"]', email);

  // Warten bis csrf geladen (Submit aktiv) und Turnstile-Dummy gelöst ist.
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLInputElement>(
      'input[name="cf-turnstile-response"]',
    );
    return Boolean(el && el.value.length > 0);
  });

  // Open-Redirect-Versuch: callbackUrl auf fremde Origin manipulieren.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>(
      'input[name="callbackUrl"]',
    );
    if (el) el.value = "https://evil.example";
  });

  await page.click('button[type="submit"]');
  await page.waitForURL("**/login/check-email**");

  const link = await fetchMagicLink(request, email);
  await page.goto(link);

  // redirect-Callback normalisiert auf die eigene Origin.
  await page.waitForURL("http://localhost:3000/**");
  expect(new URL(page.url()).origin).toBe("http://localhost:3000");
  expect(page.url()).not.toContain("evil.example");

  const session = (await (
    await page.request.get("/api/auth/session")
  ).json()) as {
    user?: { email?: string };
  };
  expect(session.user?.email).toBe(email);
});

test("manipulierter/abgelaufener Magic-Link: Fehlerseite, keine Session", async ({
  page,
}) => {
  flowOnly();
  await page.goto(
    "/api/auth/callback/email?email=e2e-invalid%40example.com&token=manipuliert",
  );
  await page.waitForURL("**/login/error**");
  await expect(page.getByText(/ungültig oder abgelaufen/)).toBeVisible();

  const session = (await (
    await page.request.get("/api/auth/session")
  ).json()) as {
    user?: unknown;
  };
  expect(session.user).toBeFalsy();
});

test("Rate-Limit: 6. Magic-Link-Anfrage derselben Adresse → 429", async ({
  request,
}) => {
  flowOnly();
  const email = `e2e-ratelimit-${Date.now()}@example.com`;
  const { csrfToken } = (await (
    await request.get("/api/auth/csrf")
  ).json()) as {
    csrfToken: string;
  };

  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const res = await request.post("/api/auth/signin/email", {
      form: {
        csrfToken,
        email,
        callbackUrl: "/de",
        "cf-turnstile-response": "e2e-dummy-token",
      },
    });
    lastStatus = res.status();
  }
  expect(lastStatus).toBe(429);
});

test("FR-Login: «Envoyer le lien de connexion» nicht abgeschnitten", async ({
  page,
}) => {
  await page.goto("/fr/login");
  const btn = page.getByRole("button", {
    name: "Envoyer le lien de connexion",
  });
  await expect(btn).toBeVisible();
  const clipped = await btn.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
  expect(clipped).toBe(false);
});
