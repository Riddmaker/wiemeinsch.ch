import { expect, test } from "@playwright/test";
import { loginAs, requestMagicLink } from "./helpers";

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

test("Rate-Limit: 6. Magic-Link-Anfrage derselben Adresse → Fehlerseite", async ({
  page,
}) => {
  flowOnly();
  const email = `e2e-ratelimit-${Date.now()}@example.com`;

  const outcomes: string[] = [];
  for (let i = 0; i < 6; i++) {
    outcomes.push(await requestMagicLink(page, email));
  }
  // Seit 25.09.2026 zählt das Limit im signIn-Callback (nach CSRF und
  // Turnstile) und leitet auf die lokalisierte Fehlerseite um.
  expect(outcomes.slice(0, 5)).toEqual(Array(5).fill("sent"));
  expect(outcomes[5]).toBe("RateLimit");
});

test("Rate-Limit greift auch bei Komma- und Doppelfeld-Varianten", async ({
  page,
}) => {
  flowOnly();
  const email = `e2e-variant-${Date.now()}@example.com`;
  // Varianten, die früher je einen eigenen Limit-Schlüssel ergaben, aber an
  // dieselbe Adresse gingen: Komma-Suffix wird jetzt abgelehnt …
  expect(await requestMagicLink(page, `${email},1`)).toBe("EmailSignin");

  // … und fünf echte Anforderungen erschöpfen das Budget dieser Adresse,
  // gleich in welcher Schreibweise sie ankommt.
  for (let i = 0; i < 5; i++) {
    expect(
      await requestMagicLink(page, i % 2 ? email.toUpperCase() : email),
    ).toBe("sent");
  }
  expect(await requestMagicLink(page, ` ${email} `)).toBe("RateLimit");
});

test("Registrierung über /fr bleibt französisch — samt Anmelde-Mail", async ({
  page,
  request,
}) => {
  flowOnly();
  const email = `e2e-fr-${Date.now()}@example.com`;
  expect(await requestMagicLink(page, email, "/fr")).toBe("sent");

  // Die Mail spricht die Sprache der Anmeldung.
  let subject = "";
  for (let attempt = 0; attempt < 20 && !subject; attempt++) {
    const list = await request.get(`${MAILPIT}/api/v1/messages?limit=20`);
    const data = (await list.json()) as {
      messages?: { Subject?: string; To?: { Address: string }[] }[];
    };
    subject =
      data.messages?.find((m) =>
        m.To?.some((to) => to.Address.toLowerCase() === email),
      )?.Subject ?? "";
    if (!subject) await new Promise((r) => setTimeout(r, 500));
  }
  expect(subject).toBe("Votre lien de connexion pour wiemeinsch.ch");

  // Nach dem Klick landet das neue Konto auf /fr und bleibt dort — vorher
  // leitete die Profilsprache (Default DE) sofort auf /de um.
  const link = await fetchMagicLink(request, email);
  await page.goto(link);
  await page.waitForURL("http://localhost:3000/fr**");
  await page.goto("/fr/faq");
  await expect(page).toHaveURL(/\/fr\/faq$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
});

test("Einwilligung: erst zustimmen, dann mitmachen — ablehnen meldet ab", async ({
  page,
  request,
}) => {
  flowOnly();
  const email = `e2e-consent-${Date.now()}@example.com`;
  expect(await requestMagicLink(page, email, "/fr/tickets/new")).toBe("sent");
  await page.goto(await fetchMagicLink(request, email));

  // Neues Konto: zuerst die Zustimmung, in der Sprache der Anmeldung, mit
  // dem ursprünglichen Ziel als `next`.
  await page.waitForURL("**/fr/zustimmung**");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/fr/tickets/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Avant de participer",
  );

  // Ohne Einwilligung führt jede andere Seite zurück — ausser den Seiten,
  // die man zum Entscheiden braucht.
  await page.goto("/fr/einstellungen");
  await page.waitForURL("**/fr/zustimmung**");
  await page.goto("/fr/datenschutz");
  await expect(page).toHaveURL(/\/fr\/datenschutz$/);

  // Ablehnen meldet ab; als Gast ist das Board wieder lesbar.
  await page.goto("/fr/zustimmung");
  await page.getByTestId("consent-decline").click();
  await page.waitForURL(/\/fr$/);
  const guest = (await (
    await page.request.get("/api/auth/session")
  ).json()) as { user?: unknown };
  expect(guest.user).toBeUndefined();

  // Erneut anmelden und zustimmen: weiter zum ursprünglichen Ziel, und die
  // Zustimmung bleibt — kein zweites Fragen.
  await loginAs(page, email, "/fr/tickets/new");
  await expect(page).toHaveURL(/\/fr\/tickets\/new$/);
  await page.goto("/fr/einstellungen");
  await expect(page).toHaveURL(/\/fr\/einstellungen$/);
});

test("Datenschutz: Footer-Link und Hinweis beim Login", async ({ page }) => {
  await page.goto("/de/login");
  const hint = page.getByTestId("login-privacy-hint");
  await expect(hint).toContainText("@handle");
  await page.getByTestId("footer-privacy").click();
  await expect(page).toHaveURL(/\/de\/datenschutz$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Datenschutz",
  );
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
