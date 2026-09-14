import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { login, loginAs } from "./helpers";

/**
 * E2E Political Pull Request (T10) — läuft gegen die lokale Compose-Instanz
 * und für den Antrags-/Merge-Flow gegen die ECHTE Mistral-API (Linter +
 * Übersetzung). Drei Rollen in eigenen Browser-Kontexten:
 *   A = seed-user-1 (anna_test) — Original-Autor von seed-ticket-4
 *   B = seed-user-2 (luc_test)  — stellt den Antrag, der gemergt wird
 *   C = Wegwerf-User            — stellt den Antrag, der veraltet und abgelehnt wird
 *
 * E15 (14.09.2026) ergänzt einen zweiten Zyklus: Zurückgeben → Überarbeiten →
 * Anpassen & übernehmen, plus Zurückziehen.
 *
 * Der Server-Bypass (fremder User ruft Merge auf, eigener Antrag, 199/3001
 * Zeichen) ist in tests/unit/change-request-actions abgedeckt — Server Actions
 * sind aus dem Browser nur über die build-spezifische Next-Action-Id aufrufbar
 * (gleiche Aufteilung wie T7/T9).
 */

/**
 * Serieller Modus: Alle Tests dieser Datei teilen sich die beiden Seed-Rollen-
 * Sessions aus `beforeAll` und arbeiten auf demselben Ticket. Bei
 * `fullyParallel` liefe `beforeAll` pro Worker — mehrere gleichzeitige
 * Magic-Link-Anforderungen für dieselbe Adresse entwerten sich gegenseitig.
 */
test.describe.configure({ mode: "serial" });

const EDITOR = ".editor-text .tiptap";
/**
 * Seit E12 (04.09.2026) enthält das Antragsformular alle Inhaltsfelder in der
 * Reihenfolge Problem, Lösung, Finanzierung. Dieser Test ändert bewusst NUR
 * die Lösung — die Assertions unten prüfen `ticket-solution`.
 */
const SOLUTION_EDITOR = 1;
const TICKET = "/de/tickets/seed-ticket-4";
const BASE_URL = "http://localhost:3000";

const AUTHOR_EMAIL = "anna_test@example.com";
const PROPOSER_EMAIL = "luc_test@example.com";
/** Profil von luc_test — dort erscheint die Rückgabe-Benachrichtigung (E15). */
const PROPOSER_PROFILE = "/fr/profil/seed-user-2";

/**
 * Alle Tests mit Seed-Rollen-Login laufen NUR auf chromium: Magic-Links sind
 * auf 5 pro Adresse und 15 Minuten limitiert (P4) — liefen beide Projekte
 * parallel, würden sich die Läufe gegenseitig aussperren. Der Gast-Test
 * braucht keinen Login und läuft auf beiden Profilen.
 */
const chromiumOnly = () =>
  test.skip(
    test.info().project.name !== "chromium",
    "Login-Test: nur chromium",
  );

/**
 * Sachliche Gegenvorschläge > 200 Zeichen (Civic-Linter-tauglich) — jeweils in
 * der Profil-Sprache des Antragstellers: luc_test schreibt Französisch, der
 * Wegwerf-User Deutsch. Die Referenz-Marke überlebt die AI-Übersetzung und
 * dient als Wiedererkennung in allen drei Sprachfassungen.
 */
const proposalFr = (marker: string) =>
  `La Confédération fixe une norme minimale contraignante pour les bornes de recharge sur les routes nationales et y ajoute un nombre minimal de points de charge par aire de repos. Les exploitants publient le prix par kilowattheure ainsi que la disponibilité en temps réel. La mise en œuvre est évaluée après trois ans. Référence ${marker}`;

const proposalDe = (marker: string) =>
  `Der Bund legt einen verbindlichen Mindeststandard für Ladestationen an Nationalstrassen fest und ergänzt ihn um eine Mindestanzahl Ladepunkte je Rastplatz. Betreiber veröffentlichen die Preise pro Kilowattstunde sowie die Verfügbarkeit in Echtzeit. Die Umsetzung wird nach drei Jahren evaluiert. Referenz ${marker}`;

/**
 * Card eines Antrags, dessen Vorschlag den Marker HINZUFÜGT.
 *
 * Adressiert über das `<ins>` des Diffs, nicht über den Kartentext: Der Diff
 * zeigt auch die alte Fassung, und nach einem Merge stünde deren Text in
 * JEDER Karte (E13). Vor dem Merge ist der Marker genau in einer Karte eine
 * Hinzufügung — danach nicht mehr, deshalb wird die Karte für spätere
 * Assertions über ihre laufende Nummer festgehalten (siehe `cardNumber`).
 */
function cardWithProposal(page: Page, marker: string): Locator {
  return page.locator('[data-testid="change-request-card"]').filter({
    has: page.locator('[data-testid="change-request-diff-solution"] ins', {
      hasText: marker,
    }),
  });
}

/**
 * Laufende Nummer einer Karte — sprachunabhängig: «Änderungsantrag #50»,
 * «Demande de modification n° 50», «Richiesta di modifica n. 50».
 */
async function cardNumber(card: Locator): Promise<number> {
  const label = await card.getByTestId("change-request-number").innerText();
  const match = /(\d+)\s*$/.exec(label);
  expect(match, `Kartennummer nicht lesbar: ${label}`).not.toBeNull();
  return Number(match![1]);
}

/**
 * Karte über ihre Nummer — stabil auch nach einem Merge und in jeder
 * Profilsprache (E15: der Antragsteller luc_test liest Französisch). Die
 * Anker verhindern, dass «5» auch «50» oder «15» trifft.
 */
function cardByNumber(page: Page, number: number): Locator {
  return page.locator('[data-testid="change-request-card"]').filter({
    has: page.locator('[data-testid="change-request-number"]', {
      hasText: new RegExp(`(?:^|\\D)${String(number)}$`),
    }),
  });
}

/**
 * Antragskarten sind seit E13 `<details>` und per Default EINGEKLAPPT — der
 * Inhalt steht im DOM, ist aber nicht sichtbar. Vor jeder Interaktion muss
 * die Karte deshalb geöffnet werden, wie es auch ein Mensch täte.
 */
async function openCard(card: Locator): Promise<void> {
  if (await card.evaluate((el) => (el as HTMLDetailsElement).open)) {
    return;
  }
  await card.locator("summary").click();
  await expect(card).toHaveAttribute("open", "");
}

async function openAllCards(page: Page): Promise<void> {
  const cards = page.locator('[data-testid="change-request-card"]');
  for (let i = 0; i < (await cards.count()); i += 1) {
    await openCard(cards.nth(i));
  }
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * Sessions der beiden Seed-Rollen werden EINMAL pro Datei aufgebaut und als
 * storageState wiederverwendet: Magic-Links sind auf 5 pro Adresse und 15
 * Minuten limitiert (P4) — ein Login pro Test würde das Limit reissen.
 */
let authorState: StorageState;
let proposerState: StorageState;

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    return;
  }
  authorState = await sessionFor(browser, AUTHOR_EMAIL);
  proposerState = await sessionFor(browser, PROPOSER_EMAIL);
});

async function sessionFor(
  browser: Browser,
  email: string,
): Promise<StorageState> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await loginAs(page, email);
  const state = await context.storageState();
  await context.close();
  return state;
}

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
 * Editoren werden IMMER innerhalb des PPR-Abschnitts adressiert — auf der
 * Detailseite steht zusätzlich das Statement-Formular aus P9.
 */
async function fillEditor(scope: Locator, index: number, text: string) {
  const page = scope.page();
  const editor = scope.locator(EDITOR).nth(index);
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(text);
}

/**
 * Vorbedingung herstellen: Der Autor lehnt alle noch laufenden Anträge aus
 * früheren Läufen ab — offene UND zur Überarbeitung zurückgegebene (E15).
 * Ohne das blendet die Seite das Antragsformular für einen Antragsteller mit
 * laufendem Antrag aus (eine Regel, die der Test selbst prüft).
 */
async function declineAllOpen(page: Page) {
  await openAllCards(page);
  const buttons = page.getByTestId("change-request-decline");
  for (let open = await buttons.count(); open > 0; open--) {
    await buttons.first().click();
    await expect(buttons).toHaveCount(open - 1, { timeout: 120_000 });
  }
}

/** Kompletter Antrags-Flow: Formular öffnen, Linter, Preview, einreichen. */
async function submitProposal(page: Page, text: string) {
  const section = page.getByTestId("change-request-section");
  await page.getByTestId("change-request-open").click();
  await fillEditor(section, SOLUTION_EDITOR, text);
  await page.getByTestId("change-request-prepare").click();

  // Übersetzungs-Preview: das Original weicht den zwei Fassungen FR + IT.
  await expect(page.getByTestId("change-request-submit")).toBeVisible({
    timeout: 180_000,
  });
  await expect(section.locator(EDITOR)).toHaveCount(2);

  await page.getByTestId("change-request-submit").click();
  await expect(page.getByTestId("change-request-own-open")).toBeVisible({
    timeout: 240_000,
  });
}

test(
  "PPR-Zyklus: Antrag → Merge (Co-Autor, 3 Sprachen) → Stale-Warnung → Ablehnen",
  { tag: "@ai" },
  async ({ browser }) => {
    chromiumOnly();
    test.setTimeout(900_000); // 2 × (Linter + Übersetzung + 3 Linter) + Merge

    const stamp = `PPR-${Date.now() % 100000}`;
    const proposalB = proposalFr(`${stamp}-B`);
    const proposalC = proposalDe(`${stamp}-C`);

    // --- A räumt Anträge aus früheren Läufen ab -----------------------------
    const pageA = await newPage(browser, authorState);
    await pageA.goto(TICKET);
    await declineAllOpen(pageA);

    // --- B stellt einen Änderungsantrag -------------------------------------
    const pageB = await newPage(browser, proposerState);
    await pageB.goto(TICKET);
    const cardsBefore = await pageB.getByTestId("change-request-card").count();
    await submitProposal(pageB, proposalB);
    await expect(pageB.getByTestId("change-request-card")).toHaveCount(
      cardsBefore + 1,
    );

    // --- C stellt einen zweiten Antrag auf derselben Basis -------------------
    const pageC = await newPage(browser);
    await login(pageC, "e2e-ppr");
    await pageC.goto(TICKET);
    await submitProposal(pageC, proposalC);

    // --- A (Original-Autor) sieht beide Anträge, kann selbst keinen stellen ---
    await pageA.reload();
    await expect(pageA.getByTestId("change-request-open")).toHaveCount(0);
    await expect(pageA.getByTestId("change-request-author-hint")).toContainText(
      "Entscheid",
    );

    // Co-Autorschaften waechst pro gemergtem Antrag — Assert relativ zum Stand
    // vor dem Merge (frühere Läufe haben ggf. schon welche erzeugt).
    const coAuthors = pageA.getByTestId("co-author");
    const coAuthorsBefore = await coAuthors.count();

    const cardB = cardWithProposal(pageA, `${stamp}-B`);
    const cardC = cardWithProposal(pageA, `${stamp}-C`);
    await expect(cardB).toHaveCount(1);
    await expect(cardC).toHaveCount(1);
    // Genau diese zwei Anträge sind offen und liegen beim Autor zum Entscheid.
    await expect(pageA.getByTestId("change-request-review")).toHaveCount(2);

    // E13: Karten sind eingeklappt — die Entscheid-Knöpfe erscheinen erst
    // beim Aufklappen. Die Zusammenfassung nennt vorher, was betroffen ist.
    await expect(cardB.getByTestId("change-request-fields")).toContainText(
      "Lösung",
    );
    await openCard(cardB);
    await openCard(cardC);
    await expect(cardB.getByTestId("change-request-review")).toBeVisible();
    await expect(cardC.getByTestId("change-request-review")).toBeVisible();

    // Diff: der Vorschlag steht als Hinzufügung, die alte Fassung als
    // Streichung — beides im selben Block (E13).
    const diffB = cardB.getByTestId("change-request-diff-solution");
    // Über das `<ins>` MIT dem Marker: Ähnelt der Ticket-Text dem Vorschlag,
    // zerfällt die Hinzufügung in viele Stücke (Strict-Mode-Verletzung).
    await expect(diffB.locator("ins", { hasText: `${stamp}-B` })).toHaveCount(
      1,
    );
    await expect(diffB.locator("del")).not.toHaveCount(0);

    // Nummern festhalten: Nach dem Merge trägt der Diff jeder Karte den
    // gemergten Text, der Marker taugt dann nicht mehr zur Adressierung.
    const numberB = await cardNumber(cardB);
    const numberC = await cardNumber(cardC);

    // --- A merged den Antrag von B ------------------------------------------
    // E15: «Übernehmen» ist 1:1 — eine Bestätigung, keine Editoren.
    await cardB.getByTestId("change-request-review").click();
    await expect(cardB.getByTestId("change-request-merge")).toBeVisible();
    await expect(cardB.locator(EDITOR)).toHaveCount(0);
    await cardB.getByTestId("change-request-merge").click();

    // Lösungstext des Tickets ist ersetzt, B als CO_AUTHOR vermerkt.
    const solution = pageA.getByTestId("ticket-solution");
    await expect(solution).toContainText(`${stamp}-B`, { timeout: 240_000 });
    await expect(coAuthors).toHaveCount(coAuthorsBefore + 1);
    await expect(coAuthors.last()).toContainText("@luc_test");
    await expect(coAuthors.last()).toContainText("Änderungsantrag #");
    await expect(
      cardByNumber(pageA, numberB).getByTestId("change-request-status"),
    ).toHaveText("Gemergt");
    // Unverändert übernommen: kein Anpassungs-Vermerk (Attribution, E15).
    await expect(
      cardByNumber(pageA, numberB).getByTestId("change-request-adjusted"),
    ).toHaveCount(0);

    // --- Der Antrag von C ist jetzt veraltet (10.4) --------------------------
    await pageA.reload();
    const staleCard = cardByNumber(pageA, numberC);
    await openCard(staleCard);
    await expect(staleCard.getByTestId("change-request-stale")).toBeVisible();

    // --- A lehnt den Antrag von C ab ----------------------------------------
    await staleCard.getByTestId("change-request-decline").click();
    await expect(
      cardByNumber(pageA, numberC).getByTestId("change-request-status"),
    ).toHaveText("Abgelehnt", { timeout: 120_000 });
    // Lösung unverändert: weiterhin die Fassung von B, kein zweiter Co-Autor.
    await expect(solution).toContainText(`${stamp}-B`);
    await expect(coAuthors).toHaveCount(coAuthorsBefore + 1);

    // --- Der neue Lösungstext existiert in allen drei Sprachen ---------------
    for (const locale of ["fr", "it"]) {
      await pageA.goto(`/${locale}/tickets/seed-ticket-4`);
      await expect(pageA.getByTestId("ticket-solution")).toContainText(
        `${stamp}-B`,
      );
    }

    await pageA.context().close();
    await pageB.context().close();
    await pageC.context().close();
  },
);

test(
  "E15: Zurückgeben → Überarbeiten → Anpassen & übernehmen, und Zurückziehen",
  { tag: "@ai" },
  async ({ browser }) => {
    chromiumOnly();
    // 3 × (Linter + Übersetzung + 3 Linter) + Anpassung (Linter + Übersetzung
    // + 3 Linter).
    test.setTimeout(1_200_000);

    const stamp = `REV-${Date.now() % 100000}`;

    const pageA = await newPage(browser, authorState);
    await pageA.goto(TICKET);
    await declineAllOpen(pageA);

    // --- B stellt einen Antrag ----------------------------------------------
    const pageB = await newPage(browser, proposerState);
    await pageB.goto(TICKET);
    await submitProposal(pageB, proposalFr(`${stamp}-1`));

    // --- A gibt ihn mit einem Grund aus dem Katalog zurück ------------------
    await pageA.reload();
    const card = cardWithProposal(pageA, `${stamp}-1`);
    await expect(card).toHaveCount(1);
    const number = await cardNumber(card);
    await openCard(card);
    await card.getByTestId("change-request-return").click();
    // Ohne Grund kein Zurückgeben — es gibt kein Freitextfeld.
    await expect(
      card.getByTestId("change-request-return-confirm"),
    ).toBeDisabled();
    await expect(card.locator("textarea")).toHaveCount(0);
    await card.getByTestId("change-request-reason-ZU_WENIG_KONKRET").check();
    await card.getByTestId("change-request-return-confirm").click();

    const returned = cardByNumber(pageA, number);
    await expect(returned.getByTestId("change-request-status")).toHaveText(
      "In Überarbeitung",
      { timeout: 60_000 },
    );
    await expect(
      returned.getByTestId("change-request-return-reason"),
    ).toContainText("Zu wenig konkret");
    // Solange der Antrag beim Antragsteller liegt: nur noch Ablehnen.
    await openCard(returned);
    await expect(returned.getByTestId("change-request-awaiting")).toBeVisible();
    await expect(returned.getByTestId("change-request-review")).toHaveCount(0);

    // --- B wird benachrichtigt und sieht den Grund --------------------------
    await pageB.goto(PROPOSER_PROFILE);
    await expect(
      pageB.getByTestId("notification-returnedChangeRequests"),
    ).toBeVisible();
    await pageB.goto(TICKET);
    await expect(pageB.getByTestId("change-request-own-open")).toBeVisible();
    const own = cardByNumber(pageB, number);
    // Für den Antragsteller klappt die zurückgegebene Karte von selbst auf.
    await expect(own).toHaveAttribute("open", "");
    await expect(own.getByTestId("change-request-return-reason")).toContainText(
      "Pas assez concret",
    );

    // --- B überarbeitet ------------------------------------------------------
    await own.getByTestId("change-request-edit").click();
    await fillEditor(own, SOLUTION_EDITOR, proposalFr(`${stamp}-2`));
    await own.getByTestId("change-request-prepare").click();
    await expect(own.getByTestId("change-request-submit")).toBeVisible({
      timeout: 180_000,
    });
    await own.getByTestId("change-request-submit").click();
    const revised = cardByNumber(pageB, number);
    await expect(revised.getByTestId("change-request-status")).toHaveText(
      "Ouverte",
      { timeout: 240_000 },
    );
    await expect(revised.getByTestId("change-request-revised")).toBeVisible();
    // Überarbeitet wurde DERSELBE Antrag — keine zweite Karte.
    await expect(cardByNumber(pageB, number)).toHaveCount(1);

    // --- A passt an und übernimmt ------------------------------------------
    await pageA.reload();
    const toAdjust = cardByNumber(pageA, number);
    await openCard(toAdjust);
    await expect(
      toAdjust
        .getByTestId("change-request-diff-solution")
        .locator("ins", { hasText: `${stamp}-2` }),
    ).toHaveCount(1);
    await toAdjust.getByTestId("change-request-adjust").click();
    // Genau ein Editor: A passt nur das Feld an, das der Antrag betrifft,
    // und nur in der eigenen Sprache.
    await expect(toAdjust.locator(EDITOR)).toHaveCount(1);
    await fillEditor(toAdjust, 0, proposalDe(`${stamp}-3`));
    await toAdjust.getByTestId("change-request-adjust-prepare").click();
    await expect(
      toAdjust.getByTestId("change-request-adjust-merge"),
    ).toBeVisible({ timeout: 180_000 });
    // Preview: die zwei anderen Sprachen, neu übersetzt.
    await expect(toAdjust.locator(EDITOR)).toHaveCount(2);
    await toAdjust.getByTestId("change-request-adjust-merge").click();

    await expect(pageA.getByTestId("ticket-solution")).toContainText(
      `${stamp}-3`,
      { timeout: 240_000 },
    );
    const merged = cardByNumber(pageA, number);
    await expect(merged.getByTestId("change-request-status")).toHaveText(
      "Gemergt",
    );
    // Attribution: die Anpassung ist auf der Karte UND im Co-Autor-Vermerk
    // sichtbar; der Diff zeigt, was A am Vorschlag geändert hat.
    await expect(merged.getByTestId("change-request-adjusted")).toContainText(
      "@anna_test",
    );
    await expect(pageA.getByTestId("co-author").last()).toContainText(
      "angepasst übernommen",
    );
    await openCard(merged);
    const adjustments = merged.getByTestId("change-request-diff-solution");
    await expect(
      adjustments.locator("ins", { hasText: `${stamp}-3` }),
    ).toHaveCount(1);
    await expect(
      adjustments.locator("del", { hasText: `${stamp}-2` }),
    ).toHaveCount(1);

    // --- C stellt einen Antrag und zieht ihn zurück --------------------------
    const pageC = await newPage(browser);
    await login(pageC, "e2e-withdraw");
    await pageC.goto(TICKET);
    await submitProposal(pageC, proposalDe(`${stamp}-4`));
    const withdrawCard = cardWithProposal(pageC, `${stamp}-4`);
    const withdrawNumber = await cardNumber(withdrawCard);
    await openCard(withdrawCard);
    await withdrawCard.getByTestId("change-request-withdraw").click();
    await withdrawCard.getByTestId("change-request-withdraw-confirm").click();
    await expect(
      cardByNumber(pageC, withdrawNumber).getByTestId("change-request-status"),
    ).toHaveText("Zurückgezogen", { timeout: 60_000 });
    // Danach ist ein neuer Antrag wieder möglich.
    await expect(pageC.getByTestId("change-request-open")).toBeVisible();

    await pageA.context().close();
    await pageB.context().close();
    await pageC.context().close();
  },
);

test("eigenes Ticket: kein Antragsformular, nur Autoren-Hinweis (10.5)", async ({
  browser,
}) => {
  chromiumOnly();
  const page = await newPage(browser, authorState);
  await page.goto(TICKET);

  const section = page.getByTestId("change-request-section");
  await expect(section).toBeVisible();
  await expect(page.getByTestId("change-request-open")).toHaveCount(0);
  // Kein Antragseditor im Abschnitt (der Editor auf der Seite gehoert dem
  // Statement-Formular aus P9).
  await expect(section.locator(EDITOR)).toHaveCount(0);
  await page.context().close();
});

test("Gast sieht Anträge, aber kein Formular (Login-Hinweis)", async ({
  page,
}) => {
  await page.goto(TICKET);

  await expect(page.getByTestId("change-request-section")).toBeVisible();
  await expect(page.getByTestId("change-request-login-hint")).toBeVisible();
  await expect(page.getByTestId("change-request-open")).toHaveCount(0);
});

test("199 Zeichen: Client lehnt ab, kein Einreiche-Schritt", async ({
  browser,
}) => {
  chromiumOnly();
  const page = await newPage(browser, proposerState);
  await page.goto("/de/tickets/seed-ticket-1");

  await page.getByTestId("change-request-open").click();
  await fillEditor(
    page.getByTestId("change-request-section"),
    SOLUTION_EDITOR,
    "x".repeat(199),
  );
  await page.getByTestId("change-request-prepare").click();

  // Französisch, nicht deutsch: luc_test hat Profilsprache FR, und seit E11
  // (04.09.2026) gilt die Profilsprache für die ganze Anwendung — `/de/...`
  // leitet für ihn auf `/fr/...` um.
  await expect(page.getByTestId("change-request-field-error")).toContainText(
    "200 caractères au minimum",
  );
  await expect(page.getByTestId("change-request-submit")).toHaveCount(0);
  await page.context().close();
});
