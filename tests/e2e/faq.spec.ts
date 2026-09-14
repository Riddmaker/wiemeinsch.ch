import { expect, test } from "@playwright/test";

/**
 * «FAQ & Presse» (14.09.2026): erreichbar über Header (Desktop) bzw. Footer
 * (mobil, dort ist die Header-Navigation ausgeblendet), vollständig in allen
 * drei Sprachen, Fussnoten führen zur Quelle, Pressematerial kopier- und
 * herunterladbar. Statische Seite — kein Login, keine AI-Calls.
 */

test("über die Navigation erreichbar — Header auf Desktop, Footer mobil", async ({
  page,
}, testInfo) => {
  await page.goto("/de");
  const entry =
    testInfo.project.name === "mobile"
      ? page.getByTestId("footer-faq")
      : page.getByTestId("header-faq");
  await entry.click();
  await expect(page).toHaveURL(/\/de\/faq$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "FAQ & Presse",
  );
});

for (const [locale, title, why] of [
  ["de", "FAQ & Presse", "Warum es das braucht"],
  ["fr", "FAQ & presse", "Pourquoi c'est nécessaire"],
  ["it", "FAQ e stampa", "Perché serve"],
] as const) {
  test(`${locale.toUpperCase()}: Titel, Warum zuerst, alle Abschnitte`, async ({
    page,
  }) => {
    await page.goto(`/${locale}/faq`);
    await expect(page).toHaveTitle(`${title} — wiemeinsch.ch`);

    const sections = page.getByRole("heading", { level: 2 });
    // Das Warum steht vor allem anderen (Vorgabe des Users).
    await expect(sections.first()).toHaveText(why);
    for (const id of ["why", "idea", "how", "questions", "press", "sources"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    // Die Sprungliste zeigt auf existierende Anker.
    const jumpLinks = page.locator('nav a[href^="#"]');
    await expect(jumpLinks).toHaveCount(5);
  });
}

test("Fussnoten führen zur jeweiligen Quelle mit externem Link", async ({
  page,
}) => {
  await page.goto("/de/faq");
  const footnotes = page.locator('sup a[href^="#quelle-"]');
  await expect(footnotes).toHaveCount(2);

  await footnotes.first().click();
  await expect(page).toHaveURL(/#quelle-1$/);
  const source = page.locator("#quelle-1");
  await expect(source).toBeInViewport();
  await expect(source.locator("a")).toHaveAttribute(
    "href",
    "https://doi.org/10.1073/pnas.2024292118",
  );
  await expect(source.locator("a")).toHaveAttribute("rel", /noopener/);
});

test("Kurztext lässt sich kopieren", async ({ page, context }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Zwischenablage-Rechte nur im Desktop-Projekt gesetzt",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/de/faq");

  const block = page.getByTestId("press-short");
  await block.getByTestId("press-short-copy").click();
  await expect(block.getByTestId("press-short-copy")).toHaveText("Kopiert");

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  await expect(block.locator("blockquote")).toHaveText(clipboard);
  expect(clipboard).toContain("politische Backlog der Schweiz");
});

test("Logo-Downloads sind ausgeliefert, Faktenblatt vollständig", async ({
  page,
  request,
}) => {
  await page.goto("/de/faq");

  for (const [testId, type] of [
    ["press-logo-svg", "image/svg+xml"],
    ["press-logo-png", "image/png"],
  ] as const) {
    const href = await page.getByTestId(testId).getAttribute("href");
    expect(href).toBeTruthy();
    const response = await request.get(href ?? "");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(type);
  }

  await expect(page.getByTestId("press-facts").locator("dt")).toHaveCount(7);
  await expect(
    page.getByRole("link", { name: "kontakt@wiemeinsch.ch" }),
  ).toHaveAttribute("href", "mailto:kontakt@wiemeinsch.ch");
});
