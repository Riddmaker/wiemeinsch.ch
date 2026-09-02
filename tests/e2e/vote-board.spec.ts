import { expect, test, type Locator, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * E2E Voting & Board (T8) — läuft gegen die lokale Compose-Instanz mit den
 * Seed-Score-Szenarien (seed-ticket-1: 425↑/75↓, seed-ticket-2: 5↑/0↓,
 * seed-ticket-3: 5↑/3↓ = 8 Votes < 10). Der Vote-Zyklus endet zurückgezogen,
 * damit der Test wiederholbar bleibt. Keine AI-Calls — kein Kostenbudget.
 */

const flowOnly = () =>
  test.skip(test.info().project.name !== "chromium", "Flow-Test: nur chromium");

/** Letzte Zahl im Button-Text (nach ▲/▼ und sr-only-Label), CH-Formatierung. */
async function voteCount(button: Locator): Promise<number> {
  const text = (await button.textContent()) ?? "";
  const digits = text.match(/([\d'’]+)\s*$/)?.[1];
  if (!digits) {
    throw new Error(`Kein Zähler im Button-Text: "${text}"`);
  }
  return Number(digits.replace(/['’]/g, ""));
}

/** Index des Ticket-Titels in der Card-Liste (−1 = nicht gefunden). */
async function cardIndex(page: Page, title: string): Promise<number> {
  const titles = await page
    .locator('[data-testid="ticket-card"] h3')
    .allTextContents();
  return titles.findIndex((t) => t.includes(title));
}

const TITLE_1 = "Einheitliche Prämienverbilligung schweizweit harmonisieren";
const TITLE_2 = "Tempo 30 vor allen Schulen der Stadt";
const TITLE_3 = "Informatikunterricht ab der Primarschule verbindlich machen";

test("Vote-Zyklus: abstimmen → zurückziehen → umschalten → zurückziehen (E1)", async ({
  page,
}) => {
  flowOnly();
  await login(page, "e2e-vote");
  await page.goto("/de/tickets/seed-ticket-3");

  const up = page.getByTestId("vote-up");
  const down = page.getByTestId("vote-down");
  const baseUp = await voteCount(up);
  const baseDown = await voteCount(down);

  // 1) Upvote: ▲ +1, ▼ unverändert, Button als "eigene Stimme" markiert.
  await up.click();
  await expect.poll(() => voteCount(up)).toBe(baseUp + 1);
  expect(await voteCount(down)).toBe(baseDown);
  await expect(up).toHaveAttribute("aria-pressed", "true");

  // 2) Gleicher Klick nochmals: Stimme zurückgezogen (E1).
  await up.click();
  await expect.poll(() => voteCount(up)).toBe(baseUp);
  await expect(up).toHaveAttribute("aria-pressed", "false");

  // 3) Upvote, dann Gegenklick: Umschalten — ▲ zurück, ▼ +1, nie beides.
  await up.click();
  await expect.poll(() => voteCount(up)).toBe(baseUp + 1);
  await down.click();
  await expect.poll(() => voteCount(down)).toBe(baseDown + 1);
  expect(await voteCount(up)).toBe(baseUp);
  await expect(down).toHaveAttribute("aria-pressed", "true");
  await expect(up).toHaveAttribute("aria-pressed", "false");

  // 4) Zurückziehen → Ausgangszustand (Test wiederholbar).
  await down.click();
  await expect.poll(() => voteCount(down)).toBe(baseDown);
  await expect(down).toHaveAttribute("aria-pressed", "false");

  // Reload: Server-Stand entspricht dem Ausgangszustand.
  await page.reload();
  expect(await voteCount(page.getByTestId("vote-up"))).toBe(baseUp);
  expect(await voteCount(page.getByTestId("vote-down"))).toBe(baseDown);
});

test("Vote ohne Login: abgelehnt mit Hinweis auf Login", async ({ page }) => {
  await page.goto("/de/tickets/seed-ticket-3");

  const up = page.getByTestId("vote-up");
  const before = await voteCount(up);
  await up.click();

  await expect(page.getByTestId("vote-login-hint")).toBeVisible();
  await expect(
    page.getByTestId("vote-login-hint").getByRole("link"),
  ).toHaveAttribute("href", /\/de\/login\?callbackUrl=/);
  expect(await voteCount(up)).toBe(before);
});

test("Board: Trending ist Default, Reihenfolge folgt den Score-Spalten", async ({
  page,
}) => {
  await page.goto("/de");

  await expect(page.getByTestId("tab-trending")).toHaveAttribute(
    "aria-current",
    "page",
  );

  // Getrennte ▲/▼-Zahlen auf der Card (Art. 6) — nie ein Netto-Wert.
  const firstCard = page.locator('[data-testid="ticket-card"]').first();
  await expect(firstCard).toContainText("▲");
  await expect(firstCard).toContainText("▼");

  // Trending: E=504 (t1) > E=8 (t3) > E=5 (t2). Der Vergleich trägt nur, weil
  // das Global-Setup alle Tickets zum selben Zeitpunkt neu bewertet (E9) —
  // sonst konkurrieren hier zu verschiedenen Uhrzeiten gerechnete Werte.
  const i1 = await cardIndex(page, TITLE_1);
  const i2 = await cardIndex(page, TITLE_2);
  const i3 = await cardIndex(page, TITLE_3);
  expect(i1).toBeGreaterThanOrEqual(0);
  expect(i1).toBeLessThan(i3);
  expect(i3).toBeLessThan(i2);
});

test("Consensus-Tab: breite Zustimmung schlägt laute Nische, N<10 ohne Rang", async ({
  page,
}) => {
  await page.goto("/de");
  await page.getByTestId("tab-consensus").click();
  await expect(page.getByTestId("tab-consensus")).toHaveAttribute(
    "aria-current",
    "page",
  );

  // 425↑/75↓ (Wilson ≈ 0.816) rankt über 5↑/0↓ (Wilson ≈ 0.566).
  const i1 = await cardIndex(page, TITLE_1);
  const i2 = await cardIndex(page, TITLE_2);
  const i3 = await cardIndex(page, TITLE_3);
  expect(i1).toBeGreaterThanOrEqual(0);
  expect(i1).toBeLessThan(i2);

  // 8 Votes < 10: ohne Rang, unterhalb der gerankten Liste, mit Label.
  expect(i3).toBeGreaterThan(i2);
  const card3 = page
    .locator('[data-testid="ticket-card"]')
    .filter({ hasText: TITLE_3 });
  await expect(card3.getByTestId("too-few-votes")).toBeVisible();
});

test("Kontrovers-Tab: knappe Spaltung rankt über einseitiges Volumen", async ({
  page,
}) => {
  await page.goto("/de?tab=controversial");
  await expect(page.getByTestId("tab-controversial")).toHaveAttribute(
    "aria-current",
    "page",
  );

  // t3 (5↑/3↓, Controversy ≈ 3.48) > t1 (425↑/75↓, ≈ 2.99) > t2 (5↑/0↓, 0).
  const i1 = await cardIndex(page, TITLE_1);
  const i2 = await cardIndex(page, TITLE_2);
  const i3 = await cardIndex(page, TITLE_3);
  expect(i3).toBeGreaterThanOrEqual(0);
  expect(i3).toBeLessThan(i1);
  expect(i1).toBeLessThan(i2);
});
