import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { loginAs } from "./helpers";

/**
 * E2E Profile & Transparenz (T11) gegen die lokale Compose-Instanz.
 *
 * Kern der Phase ist der nDSG-Grundsatz: Die Abstimmungshistorie und die
 * Beiträge sind öffentlich, die demografischen Angaben verlassen den Server
 * NIE pro User. Geprüft wird deshalb nicht nur, was zu sehen ist, sondern
 * auch, was in der Antwort steht — HTML UND RSC-Payload werden nach den
 * Seed-Werten und den Feldnamen durchsucht.
 */

test.describe.configure({ mode: "serial" });

const BASE_URL = "http://localhost:3000";
const AUTHOR_EMAIL = "anna_test@example.com";
const AUTHOR_ID = "seed-user-1";
/** seed-user-2 wird von keinem Test verändert — seine Seed-Werte sind stabil. */
const OTHER_ID = "seed-user-2";

/**
 * Demografie-WERTE von seed-user-2 aus prisma/seed.ts. Enum-Werte wie
 * «BERUFSLEHRE» stehen bewusst nicht hier: Sie sind zugleich Message-Keys der
 * Einstellungs-Seite und damit ohnehin im Katalog — für sie greifen die
 * LEAK_PATTERNS (Feldname + Wert).
 */
const FORBIDDEN_VALUES = ["1971", "1201", "Chef de chantier"];

/**
 * Feldnamen lassen sich nicht blind suchen: next-intl serialisiert den ganzen
 * Nachrichten-Katalog in den RSC-Payload, dort stehen «birthYear» & Co. als
 * Message-Keys mit ihrer Beschriftung («Jahrgang»). Ein LEAK sieht anders aus —
 * Feldname mit Datenwert. Genau darauf zielen diese Muster; die statische
 * Absicherung der Feldnamen leistet tests/unit/privacy-guard.test.ts.
 */
const LEAK_PATTERNS = [
  /birthYear[^A-Za-z]{0,6}\d{4}/,
  /postalCode[^A-Za-z]{0,6}\d{4}/,
  /education[^A-Za-z]{0,6}[A-Z_]{6,}/,
];

/**
 * Login-Tests laufen nur auf chromium: Magic-Links sind auf 5 pro Adresse und
 * 15 Minuten limitiert (P4) — zwei Projekte parallel sperren sich gegenseitig
 * aus. Die Gast-Sicht braucht keinen Login und läuft auf beiden Profilen.
 */
const chromiumOnly = () =>
  test.skip(
    test.info().project.name !== "chromium",
    "Login-Test: nur chromium",
  );

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

let authorState: StorageState;

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    return;
  }
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await loginAs(page, AUTHOR_EMAIL);
  authorState = await context.storageState();
  await context.close();
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

/**
 * Durchsucht die gerenderte Seite UND die rohe Server-Antwort. Die rohe
 * Antwort enthält den RSC-Payload (self.__next_f) — dort landen Serverdaten
 * auch dann, wenn sie im sichtbaren DOM nicht vorkommen.
 */
async function assertNoDemographics(page: Page, path: string) {
  const response = await page.request.get(`${BASE_URL}${path}`);
  expect(response.ok()).toBe(true);
  const raw = await response.text();
  const dom = await page.content();
  for (const needle of FORBIDDEN_VALUES) {
    expect(raw, `«${needle}» in der Server-Antwort von ${path}`).not.toContain(
      needle,
    );
    expect(dom, `«${needle}» im DOM von ${path}`).not.toContain(needle);
  }
  for (const pattern of LEAK_PATTERNS) {
    expect(raw, `${pattern} in der Server-Antwort von ${path}`).not.toMatch(
      pattern,
    );
    expect(dom, `${pattern} im DOM von ${path}`).not.toMatch(pattern);
  }
}

test("Gast sieht Historie und Beiträge, aber keine Demografie", async ({
  page,
}) => {
  await page.goto(`/de/profil/${OTHER_ID}`);

  await expect(page.getByTestId("profile-handle")).toHaveText("@luc_test");
  await expect(page.getByTestId("profile-votes-up")).toBeVisible();
  await expect(page.getByTestId("profile-votes-down")).toBeVisible();
  await expect(page.getByTestId("profile-tickets")).toBeVisible();
  // Der eigene Bereich (Einstellungen, offene Anträge) gehört nicht zur
  // öffentlichen Sicht.
  await expect(page.getByTestId("profile-own-hint")).toHaveCount(0);

  await assertNoDemographics(page, `/de/profil/${OTHER_ID}`);
});

test("Abstimmungen erscheinen getrennt nach Zustimmung und Ablehnung", async ({
  page,
}) => {
  // Aus dem Seed: seed-voter-1 hat seed-ticket-3 zugestimmt, seed-voter-6 hat
  // es abgelehnt (5 UP / 3 DOWN). Genau diese Trennung muss das Profil zeigen —
  // nie ein verrechneter Netto-Stand.
  await page.goto("/de/profil/seed-voter-1");
  await expect(page.getByTestId("profile-votes-up").locator("li")).toHaveCount(
    1,
  );
  await expect(
    page.getByTestId("profile-votes-down").locator("li"),
  ).toHaveCount(0);

  await page.goto("/de/profil/seed-voter-6");
  await expect(page.getByTestId("profile-votes-up").locator("li")).toHaveCount(
    0,
  );
  await expect(
    page.getByTestId("profile-votes-down").locator("li"),
  ).toHaveCount(1);
});

test("unbekannte User-Id ergibt 404", async ({ page }) => {
  const response = await page.goto("/de/profil/gibt-es-nicht");
  expect(response?.status()).toBe(404);
});

test("eigene Einstellungen speichern, neu laden und nirgends öffentlich zeigen", async ({
  browser,
}) => {
  chromiumOnly();
  const page = await newPage(browser, authorState);

  await page.goto("/de/einstellungen");
  await expect(page.getByTestId("settings-form")).toBeVisible();

  const stamp = String(Date.now()).slice(-6);
  const occupation = `Testberuf ${stamp}`;
  await page.getByTestId("settings-birthYear").fill("1990");
  await page.getByTestId("settings-gender").selectOption("D");
  await page.getByTestId("settings-education").selectOption("BACHELOR");
  await page.getByTestId("settings-postalCode").fill("3011");
  await page.getByTestId("settings-occupation").fill(occupation);
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();

  // Persistenz: Server liefert die Werte nach einem Reload zurück.
  await page.reload();
  await expect(page.getByTestId("settings-birthYear")).toHaveValue("1990");
  await expect(page.getByTestId("settings-gender")).toHaveValue("D");
  await expect(page.getByTestId("settings-education")).toHaveValue("BACHELOR");
  await expect(page.getByTestId("settings-postalCode")).toHaveValue("3011");
  await expect(page.getByTestId("settings-occupation")).toHaveValue(occupation);

  // Und trotzdem: auf dem EIGENEN öffentlichen Profil taucht nichts davon auf.
  await page.goto(`/de/profil/${AUTHOR_ID}`);
  await expect(page.getByTestId("profile-own-hint")).toBeVisible();
  const own = await page.content();
  for (const needle of [occupation, "1990", "3011"]) {
    expect(own, `«${needle}» auf dem eigenen Profil`).not.toContain(needle);
  }

  await page.close();
});

test("ungültige PLZ wird abgewiesen, ohne zu speichern", async ({
  browser,
}) => {
  chromiumOnly();
  const page = await newPage(browser, authorState);

  await page.goto("/de/einstellungen");
  await page.getByTestId("settings-postalCode").fill("0815");
  await page.getByTestId("settings-save").click();

  await expect(page.getByTestId("settings-error")).toBeVisible();
  await expect(page.getByTestId("settings-saved")).toHaveCount(0);

  // Serverstand unverändert: der Reload zeigt weiterhin die gültige PLZ.
  await page.reload();
  await expect(page.getByTestId("settings-postalCode")).toHaveValue("3011");

  await page.close();
});

test("Einstellungen ohne Login führen zur Anmeldung", async ({ page }) => {
  await page.goto("/de/einstellungen");
  await expect(page).toHaveURL(/\/de\/login\?callbackUrl=/);
});

test("Header verlinkt eingeloggt aufs eigene Profil", async ({ browser }) => {
  chromiumOnly();
  const page = await newPage(browser, authorState);

  await page.goto("/de");
  await expect(page.getByTestId("header-profile")).toHaveText("@anna_test");
  await page.getByTestId("header-profile").click();
  await expect(page).toHaveURL(new RegExp(`/de/profil/${AUTHOR_ID}$`));
  await expect(page.getByTestId("profile-settings-link")).toBeVisible();

  await page.close();
});
