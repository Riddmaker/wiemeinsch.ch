import { expect, test, type Page } from "@playwright/test";
import { login as loginWithPrefix } from "./helpers";

/**
 * Rate-Limits im echten Betrieb (T13) — der Nachweis, dass die Bremse nicht
 * nur im Unit-Test verdrahtet ist, sondern gegen die echte
 * PostgreSQL-Fixed-Window-Tabelle greift (Entscheid E2).
 *
 * Geprüft wird der teuerste Endpunkt: `prepareStatementPublish` löst
 * Mistral-Aufrufe aus und ist deshalb auf 10 Versuche pro 15 Minuten und
 * User begrenzt. Damit der Test kein Geld verbrennt, wird bewusst ein Text
 * gesendet, den der Civic-Linter sofort abweist — die teure zweite Stufe und
 * der Übersetzungslauf entfallen, das Limit zählt trotzdem mit.
 *
 * Der Test läuft mit einer Wegwerf-Identität: er erschöpft das Kontingent
 * dieses Users für 15 Minuten und darf keinen anderen Test blockieren.
 */

const EDITOR = ".editor-text .tiptap";
const TICKET = "seed-ticket-6";

/** Limit aus src/actions/statements.ts — hier bewusst dupliziert, damit der
 *  Test bei einer stillen Änderung des Limits auffällt statt mitzuwandern. */
const PREPARE_LIMIT = 10;

const chromiumOnly = () =>
  test.skip(
    test.info().project.name !== "chromium",
    "Rate-Limit-Flow: nur chromium",
  );

/** Vom Linter sicher beanstandet (P13.4) und damit billig in der Ausführung. */
const BLOCKED_TEXT =
  "Die Verwaltung soll Eingaben serverseitig prüfen. Aus dem Testbericht: " +
  "<script>alert(1)</script> soll als Zeichenfolge sichtbar bleiben.";

async function attempt(page: Page, suffix: number): Promise<void> {
  const editor = page.locator(EDITOR).first();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(`${BLOCKED_TEXT} (${suffix})`);
  await page.getByTestId("statement-prepare").click();
}

test(
  "AI-gestützte Action: nach dem konfigurierten Limit kommt die Bremse",
  { tag: "@ai" },
  async ({ page }) => {
    chromiumOnly();
    test.setTimeout(600_000);

    await loginWithPrefix(page, "e2e-ratelimit");
    await page.goto(`/de/tickets/${TICKET}`);
    await page.getByTestId("statement-category-ERWEITERUNG").click();

    const rateLimitBanner = page.getByText("Zu viele Versuche in kurzer Zeit", {
      exact: false,
    });

    // Die ersten N Versuche kommen durch bis zum Linter — die Bremse ist still.
    for (let i = 1; i <= PREPARE_LIMIT; i++) {
      await attempt(page, i);
      await expect(page.getByTestId("linter-feedback").first()).toBeVisible({
        timeout: 180_000,
      });
      expect(
        await rateLimitBanner.count(),
        `Versuch ${i} von ${PREPARE_LIMIT} wurde bereits gebremst`,
      ).toBe(0);
    }

    // Der Versuch danach wird abgewiesen, BEVOR irgendein AI-Aufruf passiert.
    await attempt(page, PREPARE_LIMIT + 1);
    await expect(rateLimitBanner).toBeVisible({ timeout: 30_000 });
  },
);
