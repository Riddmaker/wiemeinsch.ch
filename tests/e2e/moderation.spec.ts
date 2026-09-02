import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { login as loginWithPrefix, loginAs } from "./helpers";

/**
 * E2E Moderation & Meldungen (T12) gegen die lokale Compose-Instanz und für
 * Anfechtung/Freigabe gegen die ECHTE Mistral-Pipeline (Linter + Übersetzung).
 *
 * Kern der Phase: Der Admin-Bereich existiert für Nicht-Admins nicht (404,
 * keine Queue-Daten in der Antwort), Meldungen und Anfechtungen landen als
 * Fälle in der Queue, und ein Entscheid wirkt sichtbar — bis hin zum
 * Depublizieren, das den Inhalt überall verschwinden lässt, ohne ihn zu
 * löschen. Der Server-Bypass (Moderations-Action ohne Admin-Flag) ist in
 * tests/unit/moderation-actions.test.ts abgedeckt, wo die DB-Mutation
 * beobachtbar ist.
 */

test.describe.configure({ mode: "serial" });

const BASE_URL = "http://localhost:3000";
const ADMIN_EMAIL = "admin_test@example.com";
const SEED_TICKET = "seed-ticket-1";
/** Träger für den Depublizier-Test — nicht eines der T8-Score-Szenarien. */
const STATEMENT_TICKET = "seed-ticket-5";
const EDITOR = ".editor-text .tiptap";

/**
 * Login-Tests laufen nur auf chromium: Magic-Links sind auf 5 pro Adresse und
 * 15 Minuten limitiert (P4), und die Flow-Tests kosten echte Mistral-Calls.
 */
const chromiumOnly = () =>
  test.skip(
    test.info().project.name !== "chromium",
    "Moderations-Flow: nur chromium",
  );

// In T6/T7 verifizierte Textbausteine.
const CLEAN_PROBLEM =
  "Die Gemeinden führen ihre Vernehmlassungen heute in unterschiedlichen Fristen und Formaten durch. " +
  "Das erschwert die Beteiligung von Verbänden und Privaten und bindet in den Verwaltungen Zeit, " +
  "die für die inhaltliche Arbeit fehlt.";
const CLEAN_SOLUTION =
  "Der Bund stellt eine gemeinsame Plattform mit einheitlichen Fristen und maschinenlesbaren Formaten " +
  "bereit. Gemeinden und Kantone publizieren ihre Vernehmlassungen dort; bestehende Systeme werden " +
  "über eine offene Schnittstelle angebunden.";
const POLEMIC_SENTENCE =
  "Der Bundesrat verschläft das Problem und schiebt die Verantwortung feige ab.";
const STATEMENT_TEXT =
  "Eine gemeinsame Plattform würde die Beteiligung an Vernehmlassungen für kleine Verbände spürbar erleichtern.";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let adminState: StorageState;
let reporterState: StorageState;
/** Titel der in diesem Lauf angefochtenen Fassung — der Freigabe-Test
 *  muss GENAU diesen Fall treffen, nicht einfach den obersten. */
let appealTitle = "";

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    return;
  }
  const adminContext = await browser.newContext({ baseURL: BASE_URL });
  const adminPage = await adminContext.newPage();
  await loginAs(adminPage, ADMIN_EMAIL);
  adminState = await adminContext.storageState();
  await adminContext.close();

  // Melder: Wegwerf-Identität — die Meldung hängt an keiner festen Rolle.
  const reporterContext = await browser.newContext({ baseURL: BASE_URL });
  const reporterPage = await reporterContext.newPage();
  await loginWithPrefix(reporterPage, "e2e-moderation");
  reporterState = await reporterContext.storageState();
  await reporterContext.close();
});

async function newPage(
  browser: Browser,
  storageState?: StorageState,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    ...(storageState ? { storageState } : {}),
  });
  return context.newPage();
}

async function fillEditor(page: Page, index: number, text: string) {
  const editor = page.locator(EDITOR).nth(index);
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(text);
}

/** Meldet den ersten Beitrag der Sorte auf der offenen Seite. */
async function report(page: Page, testId: string, reasonLabel: string) {
  await page.getByTestId(testId).first().click();
  const dialog = page.getByTestId(`${testId}-dialog`).first();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(reasonLabel).check();
  await dialog.getByTestId(`${testId}-submit`).click();
  await expect(page.getByTestId(`${testId}-sent`).first()).toBeVisible();
}

test("Nicht-Admins bekommen 404 — und keine Queue-Daten in der Antwort", async ({
  browser,
  page,
}) => {
  chromiumOnly();

  // 1) Gast
  const guestResponse = await page.goto("/de/admin");
  expect(guestResponse?.status()).toBe(404);
  expect(await page.getByTestId("admin-queue").count()).toBe(0);

  // 2) Eingeloggt, aber ohne Admin-Flag — auch der Fall-Detailpfad schweigt.
  const reporterPage = await newPage(browser, reporterState);
  const response = await reporterPage.goto("/de/admin");
  expect(response?.status()).toBe(404);
  const raw = await response!.text();
  for (const needle of ["admin-queue", "admin-case-row", "admin_test"]) {
    expect(raw, `«${needle}» in der 404-Antwort`).not.toContain(needle);
  }
  const caseResponse = await reporterPage.goto("/de/admin/seed-nonexistent");
  expect(caseResponse?.status()).toBe(404);

  // 3) Der Admin-Link im Header erscheint nur für Admins.
  await reporterPage.goto("/de");
  await expect(reporterPage.getByTestId("header-admin")).toHaveCount(0);
  const adminPage = await newPage(browser, adminState);
  await adminPage.goto("/de");
  await expect(adminPage.getByTestId("header-admin")).toBeVisible();
});

test("Statement melden erzeugt einen REPORT-Fall in der Queue", async ({
  browser,
}) => {
  chromiumOnly();

  const reporterPage = await newPage(browser, reporterState);
  await reporterPage.goto(`/de/tickets/${SEED_TICKET}`);
  const statementText =
    (await reporterPage
      .getByTestId("statement-card")
      .first()
      .locator("p")
      .first()
      .textContent()) ?? "";
  expect(statementText.length).toBeGreaterThan(10);

  await report(reporterPage, "report-statement", "Beleidigung");

  // Der gemeldete Beitrag wird NICHT öffentlich markiert (Anti-Pranger).
  await reporterPage.reload();
  await expect(
    reporterPage.getByText("gemeldet", { exact: false }),
  ).toHaveCount(0);

  const adminPage = await newPage(browser, adminState);
  await adminPage.goto("/de/admin");
  const row = adminPage.getByTestId("admin-case-row").first();
  await expect(row).toHaveAttribute("data-case-type", "REPORT");
  await expect(row).toContainText("Beleidigung");
  await expect(row).toContainText(statementText.slice(0, 30));
});

test("Admin weist die Meldung ab — der Inhalt bleibt sichtbar", async ({
  browser,
}) => {
  chromiumOnly();

  const adminPage = await newPage(browser, adminState);
  await adminPage.goto("/de/admin");
  await adminPage.getByTestId("admin-case-link").first().click();
  await expect(adminPage.getByTestId("admin-case")).toBeVisible();
  await expect(adminPage.getByTestId("case-reason")).toHaveText("Beleidigung");

  await adminPage.getByTestId("case-note").fill("Kein Verstoss erkennbar.");
  await adminPage.getByTestId("case-dismiss").click();
  await expect(adminPage.getByTestId("case-resolution")).toContainText(
    "Abgewiesen",
  );
  await expect(adminPage.getByTestId("case-actions")).toHaveCount(0);

  // Der Fall ist aus der offenen Queue verschwunden und steht unter «Erledigt».
  await adminPage.goto("/de/admin");
  await expect(
    adminPage.getByTestId("admin-case-row").filter({ hasText: "Beleidigung" }),
  ).toHaveCount(0);
  await adminPage.getByTestId("admin-filter-resolved").click();
  await expect(adminPage.getByTestId("admin-case-row").first()).toContainText(
    "Abgewiesen",
  );

  // Das gemeldete Statement ist unverändert öffentlich.
  const guestPage = await newPage(browser);
  await guestPage.goto(`/de/tickets/${SEED_TICKET}`);
  await expect(guestPage.getByTestId("statement-card").first()).toBeVisible();
});

test(
  "Geblockter Ticket-Text wird angefochten und landet als APPEAL in der Queue",
  { tag: "@ai" },
  async ({ browser }) => {
    chromiumOnly();
    test.setTimeout(420_000);

    const reporterPage = await newPage(browser, reporterState);
    await reporterPage.goto("/de/tickets/new");

    const title = `Vernehmlassungen gemeinsam ausschreiben ${Date.now() % 100000}`;
    await reporterPage.fill('input[name="title"]', title);
    await fillEditor(reporterPage, 0, `${CLEAN_PROBLEM} ${POLEMIC_SENTENCE}`);
    await fillEditor(reporterPage, 1, CLEAN_SOLUTION);
    await reporterPage
      .getByRole("button", { name: "Prüfen und übersetzen" })
      .click();

    await expect(
      reporterPage.getByTestId("linter-feedback").first(),
    ).toBeVisible({ timeout: 120_000 });
    await reporterPage.getByTestId("appeal-button").click();
    await expect(reporterPage.getByTestId("appeal-status")).toContainText(
      "Moderation",
      { timeout: 120_000 },
    );

    appealTitle = title;

    const adminPage = await newPage(browser, adminState);
    await adminPage.goto("/de/admin");
    // Gezielt der EIGENE Fall: seit P13 legt auch xss.spec eine Anfechtung an
    // und läuft parallel — «der oberste Fall» kann einem anderen Test gehören.
    const row = adminPage
      .getByTestId("admin-case-row")
      .filter({ hasText: title.slice(0, 30) });
    await expect(row).toHaveAttribute("data-case-type", "APPEAL");

    // Der Fall trägt den blockierten Text UND die echten Linter-Gründe.
    await row.getByTestId("admin-case-link").click();
    await expect(adminPage.getByTestId("case-draft")).toContainText(
      POLEMIC_SENTENCE,
    );
    await expect(adminPage.getByTestId("case-findings")).toBeVisible();
    await expect(adminPage.getByTestId("case-reason")).not.toHaveText("");
    // Depublizieren gibt es bei einer Anfechtung nicht — es existiert kein Inhalt.
    await expect(adminPage.getByTestId("case-depublish")).toHaveCount(0);
  },
);

test(
  "Admin gibt die Anfechtung frei — der Text wird publiziert, inklusive Übersetzungen",
  { tag: "@ai" },
  async ({ browser }) => {
    chromiumOnly();
    test.setTimeout(420_000);

    const adminPage = await newPage(browser, adminState);
    await adminPage.goto("/de/admin");
    await adminPage
      .getByTestId("admin-case-row")
      .filter({ hasText: appealTitle.slice(0, 30) })
      .getByTestId("admin-case-link")
      .click();
    await adminPage.getByTestId("case-approve").click();

    await expect(adminPage.getByTestId("case-resolution")).toContainText(
      "Freigegeben",
      { timeout: 300_000 },
    );
    const publishedLink = adminPage.getByTestId("case-published-link");
    await expect(publishedLink).toBeVisible();
    await publishedLink.click();
    await adminPage.waitForURL(/\/de\/tickets\/[a-z0-9]+$/);
    const ticketPath = new URL(adminPage.url()).pathname;

    // Der freigegebene Text ist unverändert publiziert — mitsamt dem Satz, den
    // der Linter beanstandet hatte (genau das ist der Sinn einer Freigabe).
    await expect(adminPage.getByRole("heading", { level: 1 })).toContainText(
      "Vernehmlassungen gemeinsam ausschreiben",
    );
    await expect(adminPage.getByText(POLEMIC_SENTENCE)).toBeVisible();

    // Der Übersetzungs-Flow lief mit: die FR-Route zeigt die FR-Fassung.
    const guestPage = await newPage(browser);
    await guestPage.goto(ticketPath.replace("/de/", "/fr/"));
    await expect(guestPage.getByText("Traduit par IA")).toBeVisible();
    await expect(guestPage.getByText("Original : Allemand")).toBeVisible();
  },
);

test(
  "Gemeldetes Statement wird depubliziert und verschwindet aus der Ansicht",
  { tag: "@ai" },
  async ({ browser }) => {
    chromiumOnly();
    test.setTimeout(420_000);

    // 1) Eigenes Statement anlegen (echte Pipeline) — Seed-Inhalte bleiben so
    //    unangetastet, Board-Scores der T8-Szenarien unverändert.
    const authorPage = await newPage(browser, reporterState);
    await authorPage.goto(`/de/tickets/${STATEMENT_TICKET}`);
    // Wiedererkennungsmarke als NORMALER Satzbestandteil: ein Test-Etikett im
    // Text («Depublizier-Test 123») liest der Civic-Linter zu Recht als
    // Manipulationsversuch und blockiert das Statement.
    const marker = `Vorlage Nummer ${Date.now() % 100000}`;
    await authorPage.getByTestId("statement-category-PRO").click();
    await fillEditor(
      authorPage,
      0,
      `${STATEMENT_TEXT} Die ${marker} zeigt das exemplarisch.`,
    );
    await authorPage.getByTestId("statement-prepare").click();
    await expect(authorPage.getByTestId("statement-publish")).toBeVisible({
      timeout: 180_000,
    });
    await authorPage.getByTestId("statement-publish").click();
    await expect(authorPage.getByText(marker)).toBeVisible({
      timeout: 240_000,
    });

    // 2) Melden
    const card = authorPage
      .getByTestId("statement-card")
      .filter({ hasText: marker });
    await card.getByTestId("report-statement").click();
    const dialog = card.getByTestId("report-statement-dialog");
    await dialog.getByLabel("Spam oder Werbung").check();
    await dialog.getByTestId("report-statement-submit").click();
    await expect(card.getByTestId("report-statement-sent")).toBeVisible();

    // 3) Admin depubliziert
    const adminPage = await newPage(browser, adminState);
    await adminPage.goto("/de/admin");
    // Neuester Fall seiner Art zuoberst. Bewusst auf `REPORT` eingeschränkt
    // statt schlicht «der erste»: seit P13 legt auch xss.spec einen Fall an
    // (eine APPEAL-Anfechtung) und läuft parallel — «der erste offene Fall»
    // gehört dann unter Umständen einem anderen Test.
    await adminPage
      .locator('[data-testid="admin-case-row"][data-case-type="REPORT"]')
      .first()
      .getByTestId("admin-case-link")
      .click();
    await expect(adminPage.getByTestId("case-content")).toContainText(marker);
    await adminPage.getByTestId("case-depublish").click();
    await expect(adminPage.getByTestId("case-resolution")).toContainText(
      "Depubliziert",
      { timeout: 120_000 },
    );

    // 4) Der Inhalt ist weg — für Gäste wie für den Autor —, die Akte behält ihn.
    const guestPage = await newPage(browser);
    await guestPage.goto(`/de/tickets/${STATEMENT_TICKET}`);
    await expect(guestPage.getByText(marker)).toHaveCount(0);
    await authorPage.goto(`/de/tickets/${STATEMENT_TICKET}`);
    await expect(authorPage.getByText(marker)).toHaveCount(0);
    await expect(adminPage.getByTestId("case-content")).toContainText(marker);
  },
);
