import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, loginAs } from "./helpers";

/**
 * A11y-Abnahme (T14.2/T14.3) — axe-core über die Kernseiten.
 *
 * Geprüft wird gegen WCAG 2.1 A/AA. Erwartung
 * aus dem Testblock: **0 Violations der Stufen critical/serious**. Verstösse
 * geringerer Stufen werden mit ausgegeben, damit sie sichtbar bleiben, ohne
 * den Lauf zu blockieren.
 *
 * Ein axe-Lauf ersetzt keine manuelle Prüfung — Tastatur-Reihenfolge und
 * Fokus-Sichtbarkeit stehen deshalb als eigene Tests darunter.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Admin braucht eine feste Seed-Identität — die Queue gibt es nur für sie.
 * Bewusst der ZWEITE Seed-Admin: `admin_test` wird schon von moderation.spec
 * und xss.spec benutzt, und pro Adresse sind nur 5 Magic-Links je 15 Minuten
 * erlaubt (P4). Ein dritter Nutzer derselben Adresse machte den zweiten
 * Suite-Lauf innerhalb einer Viertelstunde rot.
 */
const ADMIN_EMAIL = "admin2_test@example.com";
const TICKET = "seed-ticket-1";
/** Ticket mit vielen Statements — deckt das Statement-Dashboard ab. */
const STATEMENT_TICKET = "seed-ticket-5";
const PROFILE_ID = "seed-user-2";

const flowOnly = () =>
  test.skip(test.info().project.name !== "chromium", "Flow-Test: nur chromium");

type Violation = {
  id: string;
  impact?: string | null;
  nodes: { target: unknown[]; html: string }[];
  help: string;
};

/** Fundstelle so ausgeben, dass sie ohne zweiten Lauf auffindbar ist. */
function describeViolation(violation: Violation): string {
  const where = violation.nodes
    .slice(0, 3)
    .map((node) => `${node.target.join(" ")} → ${node.html.slice(0, 90)}`)
    .join(" | ");
  return `${violation.id} [${violation.impact}] ${violation.help} (${violation.nodes.length}×): ${where}`;
}

/** Scannt die aktuelle Seite und gibt die Verstösse nach Schwere getrennt zurück. */
async function scan(page: Page): Promise<{
  blocking: Violation[];
  minor: Violation[];
}> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const violations = results.violations as unknown as Violation[];
  const blocking = violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  return {
    blocking,
    minor: violations.filter((v) => !blocking.includes(v)),
  };
}

/** Prüft eine Seite und macht die Fundstellen im Fehlerfall lesbar. */
async function expectAccessible(page: Page, label: string): Promise<void> {
  const { blocking, minor } = await scan(page);
  if (minor.length > 0) {
    console.log(
      `[a11y] ${label}: ${minor.length} Verstoss/Verstösse unterhalb serious — ` +
        minor
          .map((v) => `${v.id} (${v.impact}, ${v.nodes.length}×)`)
          .join(", "),
    );
  }
  expect(
    blocking.map(describeViolation),
    `axe critical/serious auf ${label}`,
  ).toEqual([]);
}

/** Öffentlich erreichbare Kernseiten — kein Login, kein AI-Budget. */
const guestPages: [label: string, path: string][] = [
  ["Board (Trending)", "/de"],
  ["Board (Consensus)", "/de?tab=consensus"],
  ["Board (Kontrovers)", "/de?tab=controversial"],
  ["Ticket-Detail", `/de/tickets/${TICKET}`],
  ["Statement-Dashboard", `/de/tickets/${STATEMENT_TICKET}`],
  ["Login", "/de/login"],
  ["Impressum", "/de/impressum"],
  ["Öffentliches Profil", `/de/profil/${PROFILE_ID}`],
  ["404", "/de/diese-seite-gibt-es-nicht"],
  // Stichproben in den beiden anderen Sprachen: gleiche Struktur, andere
  // Textlängen — abgeschnittene oder überlappende Beschriftungen fallen hier auf.
  ["Board FR", "/fr"],
  ["Ticket-Detail IT", `/it/tickets/${TICKET}`],
];

for (const [label, path] of guestPages) {
  test(`axe: ${label}`, async ({ page }) => {
    await page.goto(path);
    // Erst scannen, wenn das Dokument wirklich steht: ein noch leeres HTML
    // liefert sonst Scheinbefunde wie «kein <title>» oder «kein lang».
    await expect(page.locator("main")).toBeVisible();
    await expect(page).toHaveTitle(/.+/);
    await expectAccessible(page, label);
  });
}

test.describe("axe: Seiten hinter dem Login", () => {
  test.describe.configure({ mode: "serial" });

  test("Ticket-Formular und Einstellungen", async ({ page }) => {
    flowOnly();
    // Wegwerf-Identität: die Formulare sehen für jeden Eingeloggten gleich
    // aus, und das Magic-Link-Budget der Seed-User bleibt für die Specs frei,
    // die wirklich eine bestimmte Rolle brauchen (P4: 5 Links je 15 Minuten).
    await login(page, "e2e-a11y");

    await page.goto("/de/tickets/new");
    await expect(page.locator('input[name="title"]')).toBeVisible();
    await expectAccessible(page, "Ticket-Formular");

    await page.goto("/de/einstellungen");
    await expectAccessible(page, "Einstellungen");

    // Statement-Formular liegt auf der Ticket-Detailseite (eingeloggt).
    await page.goto(`/de/tickets/${STATEMENT_TICKET}`);
    await expectAccessible(
      page,
      "Ticket-Detail eingeloggt (Statement-Formular)",
    );
  });

  test("Moderations-Queue", async ({ page }) => {
    flowOnly();
    await loginAs(page, ADMIN_EMAIL);

    await page.goto("/de/admin");
    await expect(page.getByTestId("admin-queue")).toBeVisible();
    await expectAccessible(page, "Admin-Queue");
  });
});

test.describe("Tastatur-Bedienbarkeit (T14.3)", () => {
  /**
   * Im Dev-Modus hängt Next ein `<nextjs-portal>` mit dem Devtools-Overlay in
   * die Seite; es ist fokussierbar, gehört aber nicht zur Anwendung und
   * existiert im Prod-Build nicht.
   */
  const isAppElement = (tag: string) => !tag.startsWith("nextjs-");

  type FocusInfo = {
    tag: string;
    testId: string;
    text: string;
    focusVisible: boolean;
  };

  /** Tabbt durch die Seite und protokolliert jedes fokussierte Element. */
  async function tabThrough(page: Page, steps: number): Promise<FocusInfo[]> {
    const seen: FocusInfo[] = [];
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          testId: el.getAttribute("data-testid") ?? "",
          text: (el.textContent ?? "").trim().slice(0, 40),
          focusVisible:
            (style.outlineStyle !== "none" &&
              parseFloat(style.outlineWidth || "0") > 0) ||
            (style.boxShadow !== "none" && style.boxShadow !== ""),
        };
      });
      if (!info) break;
      if (isAppElement(info.tag)) seen.push(info);
    }
    return seen;
  }

  test("Board: Tabs und Tickets sind per Tastatur erreichbar, Fokus immer sichtbar", async ({
    page,
  }) => {
    flowOnly();
    await page.goto("/de");

    const focused = await tabThrough(page, 40);
    const trail = focused
      .map((f) => `${f.tag}:${f.testId || f.text}`)
      .join(" → ");

    // Auf dem Board zeigt die Card die ▲/▼-Zahlen nur an — abgestimmt wird auf
    // der Detailseite (siehe Test darunter). Kernaktionen hier: Rangliste
    // umschalten und ein Ticket öffnen.
    for (const testId of [
      "tab-trending",
      "tab-consensus",
      "tab-controversial",
    ]) {
      expect(
        focused.some((f) => f.testId === testId),
        `${testId} nicht per Tastatur erreichbar. ${trail}`,
      ).toBe(true);
    }
    expect(
      focused.filter((f) => f.tag === "a" && f.text.length > 10).length,
      `Kein Ticket-Link im Fokusweg. ${trail}`,
    ).toBeGreaterThan(0);

    // Ein Fokus, den man nicht sieht, ist für Tastaturnutzer kein Fokus.
    const invisible = focused.filter((f) => !f.focusVisible);
    expect(
      invisible.map((f) => `${f.tag}:${f.testId || f.text}`),
      "Elemente ohne sichtbaren Fokus",
    ).toEqual([]);
  });

  test("Ticket-Detail: Navigation, Abstimmung und Statement-Bereich per Tastatur erreichbar", async ({
    page,
  }) => {
    flowOnly();
    await page.goto(`/de/tickets/${TICKET}`);

    const focused = await tabThrough(page, 60);
    const trail = focused
      .map((f) => `${f.tag}:${f.testId || f.text}`)
      .join(" → ");

    expect(
      focused.some((f) => f.testId.startsWith("vote-")),
      `Ticket-Abstimmung nicht per Tastatur erreichbar. ${trail}`,
    ).toBe(true);
    expect(
      focused.some((f) => f.testId.startsWith("statement-vote-")),
      `Statement-Abstimmung nicht per Tastatur erreichbar. ${trail}`,
    ).toBe(true);
    const invisible = focused.filter((f) => !f.focusVisible);
    expect(
      invisible.map((f) => `${f.tag}:${f.testId || f.text}`),
      "Elemente ohne sichtbaren Fokus",
    ).toEqual([]);
  });

  test("Erstes Tab-Ziel überspringt die Navigation nicht", async ({ page }) => {
    flowOnly();
    await page.goto("/de");

    const first = (await tabThrough(page, 1))[0];
    expect(first).toBeDefined();
    // Der Einstieg gehört an den Seitenanfang (Skip-Link oder Navigation) —
    // nicht mitten in die Liste.
    expect(
      ["a", "button"].includes(first!.tag),
      `Erstes Tab-Ziel: ${first!.tag}:${first!.testId || first!.text}`,
    ).toBe(true);
  });
});

test.describe("Kontrast der Farb-Semantik (T14)", () => {
  /** Relative Luminanz nach WCAG 2.1 aus einem rgb()-String. */
  function luminance(color: string): number {
    const [r, g, b] = (color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"])
      .slice(0, 3)
      .map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.03928
          ? channel / 12.92
          : Math.pow((channel + 0.055) / 1.055, 2.4);
      }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function ratio(foreground: string, background: string): number {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  test("Farb-Tokens auf Papier erreichen 4.5:1", async ({ page }) => {
    flowOnly();
    await page.goto("/de");

    // Werte aus den CSS-Tokens lesen statt sie hier zu wiederholen — eine
    // Änderung am Styleguide muss diesen Test bewegen, nicht umgehen.
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      const resolve = (token: string) => {
        probe.style.color = style.getPropertyValue(token).trim();
        return getComputedStyle(probe).color;
      };
      const values = {
        pro: resolve("--gruen-pro"),
        contra: resolve("--rot-bund"),
        meta: resolve("--grau-meta"),
        ink: resolve("--schwarz"),
        signal: resolve("--signal-rot"),
        paper: resolve("--weiss"),
        surface: resolve("--grau-flaeche"),
      };
      probe.remove();
      return values;
    });

    const checks: [string, number][] = [
      ["PRO-Grün auf Papier", ratio(tokens.pro, tokens.paper)],
      ["CONTRA-Rot auf Papier", ratio(tokens.contra, tokens.paper)],
      ["Meta-Grau auf Papier", ratio(tokens.meta, tokens.paper)],
      ["Meta-Grau auf Fläche", ratio(tokens.meta, tokens.surface)],
      ["Text-Schwarz auf Papier", ratio(tokens.ink, tokens.paper)],
      ["Signal-Rot auf Papier", ratio(tokens.signal, tokens.paper)],
    ];

    const failing = checks
      .filter(([, value]) => value < 4.5)
      .map(([name, value]) => `${name}: ${value.toFixed(2)}:1`);
    expect(
      failing,
      `Kontraste: ${checks.map(([n, v]) => `${n} ${v.toFixed(2)}:1`).join(", ")}`,
    ).toEqual([]);
  });
});
