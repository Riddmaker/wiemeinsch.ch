import { expect, test, type Locator, type Page } from "@playwright/test";
import { login as loginWithPrefix } from "./helpers";

/**
 * E2E Statement-Dashboard (T9) — läuft gegen die lokale Compose-Instanz und
 * für den Erstell-Flow gegen die ECHTE Mistral-API (Linter + Übersetzung).
 * Der Server-Bypass (<50 / >500 Zeichen) ist in tests/unit/statement-actions
 * abgedeckt; hier wird die Client-Grenze geprüft.
 */

const EDITOR = ".editor-text .tiptap";

const flowOnly = () =>
  test.skip(test.info().project.name !== "chromium", "Flow-Test: nur chromium");

const login = (page: Page) => loginWithPrefix(page, "e2e-statement");

/** Farb-Semantik aus globals.css (Styleguide Art. 7, Farbe + Chip). */
const CATEGORY_COLORS: Record<string, string> = {
  PRO: "rgb(21, 128, 61)", // --gruen-pro
  CONTRA: "rgb(218, 41, 28)", // --rot-bund
  ERWEITERUNG: "rgb(85, 96, 110)", // --grau-meta
  FRAGE: "rgb(85, 96, 110)", // --grau-meta
};

const CATEGORY_CHIPS: Record<string, string> = {
  PRO: "Pro",
  CONTRA: "Contra",
  ERWEITERUNG: "Erweiterung",
  FRAGE: "Frage",
};

/**
 * Sachliche Statements zum Statement-Testticket (Quartierhöfe), je > 50
 * Zeichen. Träger ist seed-ticket-5 und NICHT eines der T8-Score-Szenarien:
 * jeder Lauf legt echte Statements an, die sonst über E = N + 2·S die
 * Board-Reihenfolge des T8-Tests verschieben würden (P10-Befund).
 */
const STATEMENT_TEXTS: Record<string, string> = {
  PRO: "Tiefere Geschwindigkeiten vor Schulen verkürzen den Bremsweg deutlich und senken damit das Risiko schwerer Unfälle beim Schulweg.",
  CONTRA:
    "Der Busbetrieb verliert auf Tempo-30-Abschnitten Fahrplanstabilität; ohne Bevorzugung an den Knoten verschlechtert sich das Angebot.",
  ERWEITERUNG:
    "Der Vorschlag sollte die Hauptverkehrsachsen ausnehmen und stattdessen auf das kantonale Netzmodell verweisen, um Abgrenzungsfragen zu klären.",
  FRAGE:
    "Wie verhält sich der Vorschlag zur laufenden Revision des Strassenverkehrsrechts auf Bundesebene und braucht es dann noch eine kommunale Regelung?",
};

async function fillEditor(page: Page, index: number, text: string) {
  const editor = page.locator(EDITOR).nth(index);
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(text);
}

/** Letzte Zahl im Vote-Button-Text (nach ▲/▼ und sr-only-Label). */
async function voteCount(button: Locator): Promise<number> {
  const text = (await button.textContent()) ?? "";
  const digits = text.match(/([\d'’]+)\s*$/)?.[1];
  if (!digits) {
    throw new Error(`Kein Zähler im Button-Text: "${text}"`);
  }
  return Number(digits.replace(/['’]/g, ""));
}

test(
  "je 1 Statement pro Kategorie: Chip + Borderfarbe gemäss Styleguide Art. 7",
  { tag: "@ai" },
  async ({ page }) => {
    flowOnly();
    test.setTimeout(600_000); // 4 × (Linter + Übersetzung + 3 Linter-Läufe)

    await login(page);
    await page.goto("/de/tickets/seed-ticket-5");

    const before = await page.getByTestId("statement-card").count();

    const stamp = Date.now() % 100000;
    for (const category of ["PRO", "CONTRA", "ERWEITERUNG", "FRAGE"] as const) {
      await page.getByTestId(`statement-category-${category}`).click();
      await expect(
        page.getByTestId(`statement-category-${category}`),
      ).toHaveAttribute("aria-checked", "true");

      await fillEditor(page, 0, `${STATEMENT_TEXTS[category]} (${stamp})`);
      await page.getByTestId("statement-prepare").click();

      // Übersetzungs-Preview: das Original weicht den zwei Fassungen FR + IT.
      await expect(page.getByTestId("statement-publish")).toBeVisible({
        timeout: 180_000,
      });
      await expect(page.locator(EDITOR)).toHaveCount(2);

      await page.getByTestId("statement-publish").click();
      await expect(page.getByTestId("statement-prepare")).toBeVisible({
        timeout: 240_000,
      });
    }

    // Vier neue Cards, je Kategorie eine — mit Chip UND farbiger Linksborder.
    await expect(page.getByTestId("statement-card")).toHaveCount(before + 4);

    for (const category of ["PRO", "CONTRA", "ERWEITERUNG", "FRAGE"] as const) {
      const card = page
        .locator(`[data-testid="statement-card"][data-category="${category}"]`)
        .filter({ hasText: `(${stamp})` });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText(CATEGORY_CHIPS[category]!);
      const borderColor = await card.evaluate(
        (el) => getComputedStyle(el).borderLeftColor,
      );
      expect(borderColor).toBe(CATEGORY_COLORS[category]);
      const borderWidth = await card.evaluate(
        (el) => getComputedStyle(el).borderLeftWidth,
      );
      expect(borderWidth).toBe("4px");
    }
  },
);

test("49 Zeichen: Client lehnt ab, kein Publish-Schritt", async ({ page }) => {
  flowOnly();
  await login(page);
  await page.goto("/de/tickets/seed-ticket-5");

  await fillEditor(page, 0, "x".repeat(49));
  await page.getByTestId("statement-prepare").click();

  await expect(page.getByTestId("statement-field-error")).toBeVisible();
  await expect(page.getByTestId("statement-field-error")).toContainText(
    "Mindestens 50 Zeichen",
  );
  await expect(page.getByTestId("statement-publish")).toHaveCount(0);
});

test("Dashboard hat keine Antwort-Funktion (REQUIREMENTS: keine Replies)", async ({
  page,
}) => {
  await page.goto("/de/tickets/seed-ticket-1");
  const dashboard = page.getByTestId("statement-dashboard");
  await expect(dashboard).toBeVisible();

  // Weder Reply-Buttons/Links noch Eingabefelder innerhalb der Cards.
  await expect(
    dashboard.getByRole("button", {
      name: /antwort|reply|répond|rispond|kommentar/i,
    }),
  ).toHaveCount(0);
  await expect(
    dashboard.getByRole("link", { name: /antwort|reply|répond|rispond/i }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="statement-card"] textarea'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="statement-card"] .tiptap'),
  ).toHaveCount(0);

  // Einzige Interaktion: getrennte ▲/▼.
  const firstCard = page.getByTestId("statement-card").first();
  await expect(firstCard.getByTestId("statement-vote-up")).toBeVisible();
  await expect(firstCard.getByTestId("statement-vote-down")).toBeVisible();
  await expect(firstCard).toContainText("▲");
  await expect(firstCard).toContainText("▼");
});

test("Statement voten: Zahlen getrennt aktualisiert, Rückzug möglich (E1)", async ({
  page,
}) => {
  flowOnly();
  await login(page);
  await page.goto("/de/tickets/seed-ticket-1");

  const card = page
    .locator('[data-testid="statement-card"]')
    .filter({ hasText: "Eine einheitliche Grundlage" });
  const up = card.getByTestId("statement-vote-up");
  const down = card.getByTestId("statement-vote-down");
  const baseUp = await voteCount(up);
  const baseDown = await voteCount(down);

  await up.click();
  await expect.poll(() => voteCount(up)).toBe(baseUp + 1);
  expect(await voteCount(down)).toBe(baseDown);
  await expect(up).toHaveAttribute("aria-pressed", "true");

  // Zurückziehen → Ausgangszustand (Test bleibt wiederholbar).
  await up.click();
  await expect.poll(() => voteCount(up)).toBe(baseUp);
  await expect(up).toHaveAttribute("aria-pressed", "false");
});

test("ausgeloggt auf /it: IT-Fassung sichtbar, Meta nennt die Originalsprache", async ({
  page,
}) => {
  await page.goto("/it/tickets/seed-ticket-1");

  // seed-statement-1 ist FR-Original → IT-Fassung ist AI-übersetzt.
  const card = page
    .locator('[data-testid="statement-card"]')
    .filter({ hasText: "Una base uniforme" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Originale: Francese");
  await expect(card).toContainText("Tradotto dall'IA");

  // seed-statement-2 ist DE-Original.
  const german = page
    .locator('[data-testid="statement-card"]')
    .filter({ hasText: "Come verrebbe calcolato" });
  await expect(german).toContainText("Originale: Tedesco");

  // Gäste sehen den Login-Hinweis statt des Formulars.
  await expect(page.getByTestId("statement-login-hint")).toBeVisible();
});
