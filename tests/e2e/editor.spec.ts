import { expect, test } from "@playwright/test";

/**
 * E2E Constrained Editor (T5) — gegen die Dev-Testseite /de/dev/editor
 * (nur ausserhalb von production vorhanden).
 */
const PAGE = "/de/dev/editor";
const EDITOR = ".editor-text .tiptap";

/**
 * Die Spielwiese ruft im Prod-Build bewusst `notFound()` (P5) — gegen das
 * Prod-Profil (P14.1) kann dieser Spec deshalb nicht laufen. Statt dort acht
 * Fehlschläge zu produzieren, prüft er die Verfügbarkeit einmal und überspringt
 * sich mit Begründung. Der Editor selbst bleibt im Prod-Lauf abgedeckt: er
 * steckt in jedem Formular, das ticket-flow/statement-flow/change-request
 * durchspielen.
 */
let playgroundAvailable: boolean | null = null;

test.beforeEach(async ({ request }) => {
  playgroundAvailable ??= (await request.get(PAGE)).status() === 200;
  test.skip(
    !playgroundAvailable,
    "Editor-Spielwiese im Prod-Build gesperrt (notFound) — Spec läuft nur gegen das Dev-Profil.",
  );
});

test("Toolbar zeigt genau B / I / Aufzählung", async ({ page }) => {
  await page.goto(PAGE);
  const buttons = page.locator('[role="toolbar"] button');
  await expect(buttons).toHaveCount(3);
  await expect(buttons.nth(0)).toHaveText("B");
  await expect(buttons.nth(1)).toHaveText("I");
  await expect(buttons.nth(2)).toHaveText("•—");
});

test("Counter zählt live, Auto-Save überlebt Reload", async ({ page }) => {
  await page.goto(PAGE);
  await page.locator(EDITOR).click();
  await page.keyboard.type("Grüezi mitenand");
  await expect(page.getByTestId("editor-counter")).toContainText("15 /");

  await page.reload();
  await expect(page.locator(EDITOR)).toContainText("Grüezi mitenand");

  // Aufräumen für nachfolgende Tests
  await page.evaluate(() =>
    window.localStorage.removeItem("wiemeinsch:draft:dev-editor"),
  );
});

test("Paste von H1/farbigem Text kommt als normaler Absatz an", async ({
  page,
}) => {
  await page.goto(PAGE);
  await page.evaluate(() =>
    window.localStorage.removeItem("wiemeinsch:draft:dev-editor"),
  );
  await page.reload();
  await page.locator(EDITOR).click();

  await page.evaluate((selector) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error("Editor nicht gefunden");
    const dt = new DataTransfer();
    dt.setData(
      "text/html",
      '<h1 style="color:red">Grosse Überschrift</h1><p><span style="color:#ff0000">Roter Text</span></p>',
    );
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, EDITOR);

  await expect(page.locator(EDITOR)).toContainText("Grosse Überschrift");
  const json = await page.getByTestId("dev-json").textContent();
  expect(json).not.toContain("heading");
  expect(json).not.toContain("textStyle");
  expect(json).not.toContain("color");
  await expect(page.locator(`${EDITOR} h1`)).toHaveCount(0);

  await page.evaluate(() =>
    window.localStorage.removeItem("wiemeinsch:draft:dev-editor"),
  );
});

test("Highlight-API rendert rote Unterlegung mit Grund", async ({ page }) => {
  await page.goto(PAGE);
  await page.evaluate(() =>
    window.localStorage.removeItem("wiemeinsch:draft:dev-editor"),
  );
  await page.reload();
  await page.locator(EDITOR).click();
  await page.keyboard.type(
    "Die Regierung verschläft alles. Zweiter Satz bleibt sauber.",
  );

  await page.getByTestId("dev-highlight").click();
  const mark = page.locator(".linter-mark");
  await expect(mark).toHaveCount(1);
  await expect(mark).toContainText("Die Regierung verschläft alles.");
  await expect(mark).toHaveAttribute("data-reason", "POLEMIK");

  await page.getByTestId("dev-clear-highlight").click();
  await expect(page.locator(".linter-mark")).toHaveCount(0);

  await page.evaluate(() =>
    window.localStorage.removeItem("wiemeinsch:draft:dev-editor"),
  );
});
