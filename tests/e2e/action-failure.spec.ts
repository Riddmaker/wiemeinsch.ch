import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Server Actions scheitern nicht still (14.09.2026, vor dem ersten Deploy).
 *
 * Nach jedem Deploy hält ein offener Tab die Action-IDs des alten Builds. Der
 * Test stellt genau das her, ohne zwei Builds zu brauchen: Er schreibt die
 * Action-ID der Anfrage auf eine unbekannte um — der ECHTE Server antwortet
 * dann wie nach einem Deploy. Der zweite Fall bricht die Anfrage ab
 * (Verbindung weg). Beide Male wird keine Stimme geschrieben, der Test ist
 * wiederholbar. Keine AI-Calls.
 */

const TICKET = "/de/tickets/seed-ticket-3";
const TICKET_PATH = /\/de\/tickets\/seed-ticket-3$/;

/** Eine gültig geformte, aber in keinem Build vorhandene Action-ID. */
const UNKNOWN_ACTION_ID = "00".padEnd(42, "0");

async function interceptActions(
  page: Page,
  handle: "stale" | "abort",
): Promise<void> {
  await page.route(TICKET_PATH, async (route) => {
    const request = route.request();
    const headers = request.headers();
    if (request.method() !== "POST" || !headers["next-action"]) {
      await route.continue();
      return;
    }
    if (handle === "abort") {
      await route.abort("failed");
      return;
    }
    await route.continue({
      headers: { ...headers, "next-action": UNKNOWN_ACTION_ID },
    });
  });
}

test("Action aus einem älteren Build: sichtbare Meldung mit Neu laden", async ({
  page,
}) => {
  await login(page, "e2e-stale-action");
  await page.goto(TICKET);

  const up = page.getByTestId("vote-up");
  const before = await up.textContent();
  await interceptActions(page, "stale");

  await up.click();

  const notice = page.getByTestId("action-failure");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-kind", "stale");
  await expect(notice).toContainText("Diese Seite ist nicht mehr aktuell");
  await expect(notice).toBeInViewport({ ratio: 1 });

  // Nichts geschrieben, Knopf wieder bedienbar.
  await expect(up).toBeEnabled();
  await expect(up).toHaveAttribute("aria-pressed", "false");
  await expect(up).toHaveText(before ?? "");

  await page.getByTestId("action-failure-reload").click();
  await page.waitForLoadState("load");
  await expect(page.getByTestId("vote-up")).toBeVisible();
  await expect(page.getByTestId("action-failure")).toHaveCount(0);
});

test("Abgebrochene Verbindung: allgemeine Meldung, schliessbar", async ({
  page,
}) => {
  await login(page, "e2e-failed-action");
  await page.goto(TICKET);

  const up = page.getByTestId("vote-up");
  await interceptActions(page, "abort");

  await up.click();

  const notice = page.getByTestId("action-failure");
  await expect(notice).toHaveAttribute("data-kind", "failed");
  await expect(notice).toContainText("Das hat nicht geklappt");
  // Kein Neu-laden-Knopf: Die Seite ist nicht veraltet, nur die Anfrage kam nicht an.
  await expect(page.getByTestId("action-failure-reload")).toHaveCount(0);
  await expect(up).toBeEnabled();

  await page.getByTestId("action-failure-dismiss").click();
  await expect(notice).toHaveCount(0);
});
