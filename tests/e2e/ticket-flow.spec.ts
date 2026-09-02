import { expect, test, type Page } from "@playwright/test";
import { login as loginWithPrefix } from "./helpers";

/**
 * E2E Ticket-Publish-Flow (T7) — läuft gegen die lokale Compose-Instanz
 * (App :3000, Mailpit :8025) und die ECHTE Mistral-API (Kosten < 0.15 USD
 * pro Lauf). Flow-Tests nur im chromium-Projekt (Rate-Limit-/Kostenbudget).
 */
const EDITOR = ".editor-text .tiptap";

const flowOnly = () =>
  test.skip(test.info().project.name !== "chromium", "Flow-Test: nur chromium");

// Sachliche Texte (>200 Zeichen) — bewusst nahe an den in T6 verifizierten Proben.
const CLEAN_PROBLEM =
  "Heute entscheidet jede Gemeinde einzeln über die Fristen und Formate ihrer Vernehmlassungen. " +
  "Das führt zu uneinheitlichen Abläufen, erschwert die Beteiligung von Verbänden und Privaten " +
  "und verursacht in den Verwaltungen vermeidbaren Koordinationsaufwand.";
const CLEAN_SOLUTION =
  "Der Bund stellt eine gemeinsame digitale Plattform mit einheitlichen Fristen und maschinenlesbaren " +
  "Formaten bereit. Gemeinden und Kantone können ihre Vernehmlassungen dort publizieren; bestehende " +
  "Systeme werden über eine offene Schnittstelle angebunden.";
// In T6 verifizierter Polemik-Satz (wird von Stufe 2 geflaggt).
const POLEMIC_SENTENCE =
  "Der Bundesrat verschläft das Problem und schiebt die Verantwortung feige ab.";
// Beleidigung mit >200 Zeichen für das FR-Lösungsfeld (T7-Zeile 3).
const FR_INSULT_SOLUTION =
  "Les auteurs de ce projet sont des incompétents et des idiots qui ne comprennent rien. " +
  "Une plateforme commune avec des délais uniformes et des formats lisibles par machine serait mise " +
  "à disposition par la Confédération pour toutes les communes et tous les cantons du pays.";

/** Login via Magic-Link (geteilter Helfer, P8-DRY). */
const login = (page: Page) => loginWithPrefix(page, "e2e-ticket");

async function fillEditor(page: Page, index: number, text: string) {
  const editor = page.locator(EDITOR).nth(index);
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(text);
}

test(
  "Polemik blockiert → Umformulierung → Preview → Publish → Detailseite (DE + FR ausgeloggt)",
  { tag: "@ai" },
  async ({ page, browser }) => {
    flowOnly();
    test.setTimeout(420_000); // echte Linter-/Übersetzungs-Calls

    await login(page);
    await page.goto("/de/tickets/new");

    const title = `Vernehmlassungsfristen digital vereinheitlichen ${Date.now() % 100000}`;
    await page.fill('input[name="title"]', title);
    await fillEditor(page, 0, `${CLEAN_PROBLEM} ${POLEMIC_SENTENCE}`);
    await fillEditor(page, 1, CLEAN_SOLUTION);

    // 1) Polemik → Blockade mit rotem Satz-Highlight + Grund (T7-Zeile 2)
    const submit = page.getByRole("button", { name: "Prüfen und übersetzen" });
    await submit.click();
    await expect(page.locator(".linter-mark").first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("linter-feedback").first()).toBeVisible();
    await expect(
      page
        .getByTestId("linter-feedback")
        .first()
        .getByText(/CIVIC-LINTER ·/),
    ).toBeVisible();
    await expect(submit).toBeDisabled();

    // 2) Umformulierung löst die Blockade, Flow geht weiter
    await fillEditor(page, 0, CLEAN_PROBLEM);
    await expect(submit).toBeEnabled();
    await submit.click();

    // 3) Übersetzungs-Preview zeigt FR + IT (T7-Zeile 1)
    await expect(
      page.getByRole("heading", { name: "Französisch" }),
    ).toBeVisible({
      timeout: 180_000,
    });
    await expect(
      page.getByRole("heading", { name: "Italienisch" }),
    ).toBeVisible();

    // 4) Publizieren → Detailseite mit DE-Inhalt und Original-Hinweis
    await page
      .getByRole("button", { name: "Publizieren", exact: true })
      .click();
    await page.waitForURL(/\/de\/tickets\/[a-z0-9]+$/, { timeout: 240_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Vernehmlassungsfristen digital vereinheitlichen",
    );
    await expect(page.getByText("Original: Deutsch")).toBeVisible();
    await expect(page.getByText("Schweizweit")).toBeVisible();

    // 5) localStorage-Entwürfe sind nach dem Publish gelöscht (T7.7)
    const remainingDrafts = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith("wiemeinsch:draft:ticket-new"),
      ),
    );
    expect(remainingDrafts).toEqual([]);

    // 6) Ausgeloggter Besuch der FR-Route zeigt die FR-Fassung (T7-Zeile 7)
    const frPath = new URL(page.url()).pathname.replace("/de/", "/fr/");
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(frPath);
    await expect(anonPage.getByText("Original : Allemand")).toBeVisible();
    await expect(anonPage.getByText("Traduit par IA")).toBeVisible();
    await expect(anonPage.getByText("Afficher l'original")).toBeVisible();
    // Toggle: Original anzeigen → deutscher Titel
    await anonPage.getByText("Afficher l'original").click();
    await expect(anonPage.getByRole("heading", { level: 1 })).toContainText(
      "Vernehmlassungsfristen digital vereinheitlichen",
    );
    // IT-Fassung existiert ebenfalls (3 Sprachzeilen in der DB)
    const itPath = frPath.replace("/fr/", "/it/");
    await anonPage.goto(itPath);
    await expect(anonPage.getByText("Originale: Tedesco")).toBeVisible();
    await anon.close();
  },
);

test(
  "Beleidigung in editierter FR-Übersetzung → erneute Linter-Blockade",
  { tag: "@ai" },
  async ({ page }) => {
    flowOnly();
    test.setTimeout(420_000);

    await login(page);
    await page.goto("/de/tickets/new");
    await page.fill(
      'input[name="title"]',
      `Offene Verwaltungsdaten einheitlich publizieren ${Date.now() % 100000}`,
    );
    await fillEditor(page, 0, CLEAN_PROBLEM);
    await fillEditor(page, 1, CLEAN_SOLUTION);
    await page.getByRole("button", { name: "Prüfen und übersetzen" }).click();
    await expect(
      page.getByRole("heading", { name: "Französisch" }),
    ).toBeVisible({
      timeout: 180_000,
    });

    // FR-Lösung (Preview-Editor Index 1: FR problem=0, FR solution=1) ersetzen
    await fillEditor(page, 1, FR_INSULT_SOLUTION);
    await page
      .getByRole("button", { name: "Publizieren", exact: true })
      .click();

    // Erneute Blockade auf der Übersetzung — keine Detailseite
    await expect(page.getByTestId("linter-feedback").first()).toBeVisible({
      timeout: 240_000,
    });
    await expect(
      page.getByRole("button", { name: "Publizieren", exact: true }),
    ).toBeDisabled();
    expect(page.url()).toContain("/tickets/new");
  },
);

test("Duplikat-Check: ähnlicher Titel zeigt bestehendes Seed-Ticket", async ({
  page,
}) => {
  flowOnly();
  await login(page);
  await page.goto("/de/tickets/new");
  // Seed-Ticket (P2): "Tempo 30 vor allen Schulen der Stadt"
  await page.fill('input[name="title"]', "Tempo 30 vor allen Schulen");
  const box = page.getByTestId("duplicate-suggestions");
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box.getByText(/Tempo 30/)).toBeVisible();
});

test("ausgeloggt: /de/tickets/new leitet auf den Login um", async ({
  page,
}) => {
  await page.goto("/de/tickets/new");
  await page.waitForURL("**/login**");
  await expect(page.locator('input[name="email"]')).toBeVisible();
});
