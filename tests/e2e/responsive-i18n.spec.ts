import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Sicht-Abnahme DE/FR/IT (T14.4) — automatisiert, damit die Matrix aus
 * Sprache × Seite × Breite bei jedem Lauf gleich streng geprüft wird und der
 * Browser-Selbsttest sich auf das Hinsehen konzentrieren kann.
 *
 * Geprüft wird, was Textlängen kaputt machen: horizontales Scrollen der Seite,
 * einzelne Elemente, die über den Viewport hinausragen, und Beschriftungen,
 * die im Element abgeschnitten werden (ellipsis/clip statt Umbruch). FR und IT
 * sind gegenüber DE regelmässig länger — genau hier reisst es zuerst.
 */

const PAGES: [label: string, path: (locale: string) => string][] = [
  ["Board", (l) => `/${l}`],
  ["Board Consensus", (l) => `/${l}?tab=consensus`],
  ["Ticket-Detail", (l) => `/${l}/tickets/seed-ticket-1`],
  ["Statement-Dashboard", (l) => `/${l}/tickets/seed-ticket-5`],
  ["Login", (l) => `/${l}/login`],
  ["Impressum", (l) => `/${l}/impressum`],
  ["Profil", (l) => `/${l}/profil/seed-user-2`],
];

const LOCALES = ["de", "fr", "it"] as const;
/** 375 = kleinstes Zielgerät (Mobile-First), 1280 = Desktop. */
const WIDTHS = [375, 1280] as const;

type Overflow = { selector: string; right: number };

/** Elemente, die rechts aus dem Viewport ragen (Kandidaten für Abschneiden). */
async function overflowing(page: Page): Promise<Overflow[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll("body *")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        // Absichtlich versteckte Elemente (sr-only, Off-Canvas) zählen nicht.
        const style = getComputedStyle(el);
        if (style.position === "fixed" || style.visibility === "hidden") {
          return false;
        }
        return rect.width > 0 && rect.right > limit + 1;
      })
      .slice(0, 5)
      .map((el) => ({
        selector: `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`,
        right: Math.round(el.getBoundingClientRect().right),
      }));
  });
}

/** Sichtbare Beschriftungen, deren Inhalt im Element abgeschnitten wird. */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("button, a, h1, h2, h3, label, span")]
      .filter((el) => {
        const style = getComputedStyle(el);
        if (style.overflow === "visible") return false;
        // Für Screenreader versteckte Beschriftungen (sr-only) sind absichtlich
        // auf 1 px geklemmt — sie werden nie gelesen, nur vorgelesen.
        if (el.clientWidth <= 1 || el.clientHeight <= 1) return false;
        if (String(el.className).includes("sr-only")) return false;
        // Absichtliche Kürzung mit Auslassungspunkten ist eine Design-
        // Entscheidung (z.B. sehr lange Handles im Header) — sie verschluckt
        // den Text nicht stillschweigend und zählt deshalb nicht.
        if (style.textOverflow === "ellipsis") return false;
        // Bewusst scrollbare Container (Code, Tabellen) sind kein Fehler.
        if (style.overflowX === "auto" || style.overflowX === "scroll") {
          return false;
        }
        return el.scrollWidth > el.clientWidth + 1;
      })
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}: "${(el.textContent ?? "").trim().slice(0, 40)}"`,
      ),
  );
}

for (const locale of LOCALES) {
  for (const [label, path] of PAGES) {
    test(`${locale.toUpperCase()} ${label}: kein Überlauf bei 375 und 1280 px`, async ({
      page,
    }) => {
      test.skip(
        test.info().project.name !== "chromium",
        "Breiten werden im Test selbst gesetzt — ein zweites Geräteprofil brächte nichts.",
      );

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path(locale));
        await expect(page.locator("main")).toBeVisible();

        const scroll = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(
          scroll.scrollWidth,
          `${locale} ${label} @${width}px scrollt horizontal (${scroll.scrollWidth} > ${scroll.clientWidth})`,
        ).toBeLessThanOrEqual(scroll.clientWidth);

        expect(
          await overflowing(page),
          `${locale} ${label} @${width}px: Element ragt über den Viewport`,
        ).toEqual([]);

        expect(
          await clipped(page),
          `${locale} ${label} @${width}px: Beschriftung abgeschnitten`,
        ).toEqual([]);
      }
    });
  }
}

test("Sprachwechsel bleibt auf derselben Seite", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium", "Flow-Test: nur chromium");

  // Die Sprachlinks tragen als zugänglichen Namen den Sprachnamen
  // (aria-label), sichtbar ist das Kürzel — deshalb über den Text greifen.
  const switcher = (code: string) =>
    page.locator("nav a").filter({ hasText: new RegExp(`^${code}$`) });

  await page.goto("/de/impressum");
  await switcher("FR").click();
  await expect(page).toHaveURL(/\/fr\/impressum$/);
  await expect(page.locator("h1")).toContainText("Mentions légales");

  await switcher("IT").click();
  await expect(page).toHaveURL(/\/it\/impressum$/);
});

/**
 * Formulare sind der Ort, an dem lange FR/IT-Beschriftungen zuerst reissen —
 * sie liegen aber hinter dem Login und brauchen deshalb einen eigenen,
 * seriellen Block.
 */
test.describe("Formulare in FR und IT", () => {
  test.describe.configure({ mode: "serial" });

  const FORMS: [label: string, path: (locale: string) => string][] = [
    ["Ticket-Formular", (l) => `/${l}/tickets/new`],
    ["Einstellungen", (l) => `/${l}/einstellungen`],
  ];

  /**
   * EINMAL anmelden und die Session teilen: pro Adresse sind nur 5
   * Magic-Links je 15 Minuten erlaubt (P4) — vier eigene Logins liefen ins
   * Rate-Limit statt in einen Befund. Bewusst eine Wegwerf-Adresse: geprüft
   * wird das Layout, nicht eine bestimmte Identität — so hängt dieser Spec
   * nicht am Link-Budget der Seed-User, das andere Specs mitverbrauchen.
   */
  let state: Awaited<ReturnType<BrowserContext["storageState"]>>;

  test.beforeAll(async ({ browser }, testInfo) => {
    if (testInfo.project.name !== "chromium") return;
    const context = await browser.newContext({
      baseURL: "http://localhost:3000",
    });
    const page = await context.newPage();
    await login(page, "e2e-responsive");
    state = await context.storageState();
    await context.close();
  });

  for (const locale of ["fr", "it"] as const) {
    for (const [label, path] of FORMS) {
      test(`${locale.toUpperCase()} ${label}: kein Überlauf, nichts abgeschnitten`, async ({
        browser,
      }) => {
        test.skip(
          test.info().project.name !== "chromium",
          "Breiten werden im Test selbst gesetzt.",
        );
        const context = await browser.newContext({
          baseURL: "http://localhost:3000",
          storageState: state,
        });
        const page = await context.newPage();

        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(path(locale));
          await expect(page.locator("main")).toBeVisible();

          const scroll = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          expect(
            scroll.scrollWidth,
            `${locale} ${label} @${width}px scrollt horizontal`,
          ).toBeLessThanOrEqual(scroll.clientWidth);
          expect(
            await overflowing(page),
            `${locale} ${label} @${width}px: Element ragt über den Viewport`,
          ).toEqual([]);
          expect(
            await clipped(page),
            `${locale} ${label} @${width}px: Beschriftung abgeschnitten`,
          ).toEqual([]);
        }
        await context.close();
      });
    }
  }
});
