import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { login as loginWithPrefix, loginAs } from "./helpers";

/**
 * XSS-Durchgang (T13) — der Beweis, dass User- und LLM-Content überall als
 * TEXT ankommt und nirgends als Markup.
 *
 * Abweichung vom ursprünglichen Testplan, empirisch gefunden: Der Civic-
 * Linter erkennt die Nutzlasten von sich aus als «Manipulationsversuch» und
 * lässt sie gar nicht erst publizieren — eine «linter-neutrale» Formulierung
 * mit echter Nutzlast gibt es nicht. Das ist gutes Verhalten, beweist aber
 * NICHTS über das Rendering. Deshalb zwei Tests:
 *
 *   1. Der Linter blockt (erste Verteidigungslinie).
 *   2. Der Text geht über den dokumentierten Anfechtungs-Weg (P12) trotzdem
 *      in die DB — die Admin-Freigabe überspringt den Linter bewusst — und
 *      wird dort für Melder, Admin UND Gast als Text gerendert.
 *
 * Punkt 2 ist der eigentliche Nachweis: Der Linter ist eine Ton-Prüfung, kein
 * XSS-Schutz. Sicher sein muss die Ausgabe.
 */

const EDITOR = ".editor-text .tiptap";

const chromiumOnly = () =>
  test.skip(test.info().project.name !== "chromium", "Flow-Test: nur chromium");

/** Klassiker aus dem OWASP-Cheatsheet: Element-Injektion und Attribut-Ausbruch. */
const SCRIPT_PAYLOAD = "<script>alert(1)</script>";
const ATTRIBUTE_PAYLOAD = '"><img src=x onerror=alert(2)>';

test.describe.configure({ mode: "serial" });

const BASE_URL = "http://localhost:3000";
const ADMIN_EMAIL = "admin_test@example.com";
/** Eigener Träger (P13): läuft parallel zu moderation.spec, die auf
 *  seed-ticket-5 arbeitet — geteilte Statement-Listen kollidieren. */
const TICKET = "seed-ticket-6";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let browserRef: Browser;
let adminState: StorageState;
let reporterState: StorageState;
/** Wiedererkennungsmarke des in diesem Lauf erzeugten Statements. */
const stamp = `xss-${Date.now() % 100000}`;

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    return;
  }
  browserRef = browser;
  const adminContext = await browser.newContext({ baseURL: BASE_URL });
  await loginAs(await adminContext.newPage(), ADMIN_EMAIL);
  adminState = await adminContext.storageState();
  await adminContext.close();

  const reporterContext = await browser.newContext({ baseURL: BASE_URL });
  await loginWithPrefix(await reporterContext.newPage(), "e2e-xss");
  reporterState = await reporterContext.storageState();
  await reporterContext.close();
});

async function newPage(storageState?: StorageState): Promise<Page> {
  const context = await browserRef.newContext({
    baseURL: BASE_URL,
    ...(storageState ? { storageState } : {}),
  });
  return context.newPage();
}

async function fillEditor(page: Page, text: string) {
  const editor = page.locator(EDITOR).first();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(text);
}

/** Sachlicher Satz mit beiden Nutzlasten — 50–500 Zeichen. */
function payloadText(): string {
  return (
    "Die Verwaltung soll Eingaben serverseitig prüfen. Aus dem Testbericht: " +
    `${SCRIPT_PAYLOAD} und ${ATTRIBUTE_PAYLOAD} sollen als Zeichenfolge sichtbar bleiben. (${stamp})`
  );
}

/**
 * Ein Dialog ist der eindeutige Beweis, dass Code lief. Playwright schliesst
 * unbehandelte Dialoge automatisch — ohne diesen Listener würde ein
 * erfolgreicher Angriff also unbemerkt durchgehen.
 */
function failOnDialog(page: Page): { fired: string[] } {
  const fired: string[] = [];
  page.on("dialog", async (dialog) => {
    fired.push(dialog.message());
    await dialog.dismiss();
  });
  return { fired };
}

/**
 * Prüft, dass aus einer Nutzlast KEIN lebendiges Markup geworden ist.
 *
 * Bewusst NICHT geprueft wird, ob die Zeichenfolge "alert(1)" irgendwo im
 * Dokument vorkommt: Next serialisiert die Suchparameter in die
 * RSC-Nutzlast, dort steht sie als Unicode-Escape in
 * einem JS-String. Das ist Daten, kein Code — ein Verbot der Zeichenfolge
 * würde also nicht Sicherheit messen, sondern Serialisierung.
 */
async function expectNoLiveMarkup(page: Page): Promise<void> {
  // 1. Kein Skript-Element, das die Nutzlast ausführt.
  expect(
    await page.locator("script").filter({ hasText: "alert(" }).count(),
  ).toBe(0);
  // 2. Kein Element mit Inline-Event-Handler aus der Nutzlast.
  expect(await page.locator("[onerror], [onload], [onclick]").count()).toBe(0);
  // 3. Kein aus der Nutzlast entstandenes Bild.
  expect(await page.locator('img[src="x"]').count()).toBe(0);
}

test(
  "Der Civic-Linter blockt die Injektions-Nutzlast schon vor der Datenbank",
  { tag: "@ai" },
  async () => {
    chromiumOnly();
    test.setTimeout(300_000);

    const page = await newPage(reporterState);
    await page.goto(`/de/tickets/${TICKET}`);
    await page.getByTestId("statement-category-ERWEITERUNG").click();
    await fillEditor(page, payloadText());
    await page.getByTestId("statement-prepare").click();

    // Erste Verteidigungslinie: der AI-Türsteher erkennt den Manipulations-
    // versuch, es entsteht kein Statement und kein Übersetzungs-Schritt.
    await expect(page.getByTestId("linter-feedback").first()).toBeVisible({
      timeout: 180_000,
    });
    await expect(page.getByTestId("statement-publish")).toHaveCount(0);
  },
);

test(
  "Über die Anfechtung publizierte Nutzlast rendert als Text, nicht als Markup",
  { tag: "@ai" },
  async () => {
    chromiumOnly();
    test.setTimeout(600_000);

    // Der Weg, auf dem linter-blockierter Text legitim in die DB gelangt
    // (P12, User-Entscheid): anfechten, dann Admin-Freigabe OHNE erneuten
    // Linter-Lauf. Genau darum muss das RENDERING für sich sicher sein —
    // der Linter ist kein XSS-Schutz, sondern eine Ton-Prüfung.
    const reporter = await newPage(reporterState);
    const dialogs = failOnDialog(reporter);
    await reporter.goto(`/de/tickets/${TICKET}`);
    await reporter.getByTestId("statement-category-ERWEITERUNG").click();
    await fillEditor(reporter, payloadText());
    await reporter.getByTestId("statement-prepare").click();
    await expect(reporter.getByTestId("linter-feedback").first()).toBeVisible({
      timeout: 180_000,
    });
    await reporter.getByTestId("appeal-button").click();
    await expect(reporter.getByTestId("appeal-status")).toContainText(
      "Moderation",
      { timeout: 180_000 },
    );

    const admin = await newPage(adminState);
    await admin.goto("/de/admin");
    // Gezielt der eigene Fall — moderation.spec legt ebenfalls Anfechtungen an.
    const row = admin
      .getByTestId("admin-case-row")
      .filter({ hasText: "Die Verwaltung soll Eingaben serverseitig" });
    await expect(row).toHaveAttribute("data-case-type", "APPEAL");
    await row.getByTestId("admin-case-link").click();
    // Auch die Admin-Ansicht zeigt die Nutzlast als Text, nicht als Markup.
    await expect(admin.getByTestId("case-draft")).toContainText(SCRIPT_PAYLOAD);
    await expectNoLiveMarkup(admin);

    await admin.getByTestId("case-approve").click();
    await expect(admin.getByTestId("case-resolution")).toContainText(
      "Freigegeben",
      { timeout: 300_000 },
    );

    // Öffentliche Ansicht, frisch vom Server und ohne Session.
    const guest = await newPage();
    const guestDialogs = failOnDialog(guest);
    const consoleErrors: string[] = [];
    guest.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await guest.goto(`/de/tickets/${TICKET}`);

    const card = guest
      .locator('[data-testid="statement-card"]')
      .filter({ hasText: stamp });
    await expect(card).toHaveCount(1);

    // 1. Beide Nutzlasten sind SICHTBARER TEXT.
    await expect(card).toContainText(SCRIPT_PAYLOAD);
    await expect(card).toContainText(ATTRIBUTE_PAYLOAD);

    // 2. Aus dem Text ist kein Element geworden.
    expect(await card.locator("script, img, [onerror]").count()).toBe(0);

    // 3. Im Markup der Card steht die Nutzlast nur escaped. Geprüft werden
    //    öffnende TAGS, nicht die Zeichenfolge "onerror=" — die steht dort
    //    korrekterweise als Text innerhalb von &lt;img …&gt; und ist damit
    //    genau das gewünschte Ergebnis.
    const html = await card.innerHTML();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");

    // 4. Nichts ist gelaufen — weder beim Melder, beim Admin noch beim Gast.
    expect(dialogs.fired).toEqual([]);
    expect(guestDialogs.fired).toEqual([]);
    expect(consoleErrors).toEqual([]);
  },
);

test("Fehlercode aus der URL wird nicht reflektiert (Allowlist statt Echo)", async ({
  page,
}) => {
  const dialogs = failOnDialog(page);

  await page.goto(
    `/de/login/error?error=${encodeURIComponent(SCRIPT_PAYLOAD)}`,
  );

  await expectNoLiveMarkup(page);
  expect(dialogs.fired).toEqual([]);
});

test("Unbekannte Filterwerte im Admin-Query erzeugen keinen Fehler und kein Echo", async ({
  page,
}) => {
  const dialogs = failOnDialog(page);

  // Kein Admin ⇒ 404 (P12). Entscheidend ist, dass die Antwort die Nutzlast
  // nicht zurückspiegelt — auch nicht auf der Fehlerseite.
  const response = await page.goto(
    `/de/admin?status=${encodeURIComponent(SCRIPT_PAYLOAD)}&type=${encodeURIComponent(ATTRIBUTE_PAYLOAD)}`,
  );
  expect(response?.status()).toBe(404);

  await expectNoLiveMarkup(page);
  expect(dialogs.fired).toEqual([]);
});

test("Content-Security-Policy blockt injiziertes Markup als zweite Verteidigungslinie", async ({
  page,
}) => {
  const dialogs = failOnDialog(page);
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy/i.test(msg.text()))
      violations.push(msg.text());
  });

  await page.goto("/de");

  // Simuliert exakt die Folge einer HTML-Injektion: unescaped ins Dokument
  // geschriebenes Markup mit Event-Handler-Attribut. Genau dagegen wirkt
  // `script-src` ohne 'unsafe-inline' — der Handler wird nie ausgeführt.
  //
  // Bewusst NICHT geprüft wird ein per `createElement` eingefügtes Skript:
  // `strict-dynamic` vertraut solchen Skripten per Definition, weil sie von
  // bereits vertrauenswürdigem Code stammen. Der Schutz gilt injiziertem
  // MARKUP, und das ist der Weg, den ein Angreifer über Content nimmt.
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.innerHTML =
      '<img src="data:," onerror="window.__xssRan = true; alert(1)">';
    document.body.appendChild(host);
  });
  await page.waitForTimeout(500);

  expect(await page.evaluate(() => "__xssRan" in window)).toBe(false);
  expect(dialogs.fired).toEqual([]);
  expect(violations.length).toBeGreaterThan(0);
});
