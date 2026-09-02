/**
 * Seed: Stammdaten (BFS-Snapshot, Entscheid E7) + Dev-Testdaten.
 * Aufruf: `npx prisma db seed` (konfiguriert in prisma.config.ts, läuft via tsx).
 * Idempotent — mehrfaches Ausführen erzeugt keine Duplikate.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { computeTicketScores } from "../src/services/scoring";
import { PrismaClient } from "../src/generated/prisma/client";
import type { Prisma } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

// Minimales TipTap-Dokument für Testdaten.
const tiptapDoc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

async function seedCantons() {
  const cantons = JSON.parse(
    readFileSync(path.join(dataDir, "cantons.json"), "utf8"),
  ) as {
    bfsCode: number;
    abbr: string;
    nameDe: string;
    nameFr: string;
    nameIt: string;
  }[];

  for (const c of cantons) {
    await prisma.canton.upsert({
      where: { id: c.bfsCode },
      update: {
        abbr: c.abbr,
        nameDe: c.nameDe,
        nameFr: c.nameFr,
        nameIt: c.nameIt,
      },
      create: {
        id: c.bfsCode,
        abbr: c.abbr,
        nameDe: c.nameDe,
        nameFr: c.nameFr,
        nameIt: c.nameIt,
      },
    });
  }
  return cantons.length;
}

async function seedMunicipalities() {
  // CSV-Spalten: HistoricalCode,BfsCode,ValidFrom,ValidTo,Level,Parent,Name,ShortName,…
  const csv = readFileSync(
    path.join(dataDir, "bfs-communes-snapshot.csv"),
    "utf8",
  );
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(","));

  for (const r of rows) {
    if (r.length !== 12) {
      throw new Error(
        `Unerwartete CSV-Zeile (${r.length} Spalten): ${r.join(",")}`,
      );
    }
  }

  // Bezirk (Level 2): HistoricalCode → Kanton-HistoricalCode (== BFS-Kantonsnummer).
  const districtToCanton = new Map(
    rows.filter((r) => r[4] === "2").map((r) => [r[0], Number(r[5])]),
  );

  const municipalities: Prisma.MunicipalityCreateManyInput[] = rows
    .filter((r) => r[4] === "3")
    .map((r) => {
      const cantonId = districtToCanton.get(r[5] as string);
      if (cantonId === undefined) {
        throw new Error(
          `Gemeinde ${r[6]} (${r[1]}): kein Kanton für Bezirk ${r[5]} gefunden`,
        );
      }
      return { id: Number(r[1]), name: r[6] as string, cantonId };
    });

  // Snapshot-Update (E7): Namen/Zuordnungen bestehender Gemeinden nachführen.
  await prisma.municipality.createMany({
    data: municipalities,
    skipDuplicates: true,
  });
  for (const m of municipalities) {
    await prisma.municipality.update({
      where: { id: m.id },
      data: { name: m.name, cantonId: m.cantonId },
    });
  }
  return municipalities.length;
}

async function seedDevData() {
  // Die E-Mail-Adressen machen die Seed-User per Magic-Link anmeldbar — nötig
  // für Rollen-E2E (P10: Antragsteller vs. Original-Autor). Nur Dev-Daten.
  // Die Demografie-Felder sind frei erfunden und existieren einzig, damit der
  // Datenschutz-Test (P11.3/T11) nach echten Werten in öffentlichen Antworten
  // suchen kann — findet er einen, ist die Projektion undicht.
  const users = [
    {
      id: "seed-user-1",
      handle: "anna_test",
      name: "Anna Test",
      email: "anna_test@example.com",
      preferredLocale: "DE" as const,
      birthYear: 1984,
      gender: "F" as const,
      education: "MASTER_ODER_HOEHER" as const,
      postalCode: "8006",
      occupation: "Verkehrsplanerin",
    },
    {
      id: "seed-user-2",
      handle: "luc_test",
      name: "Luc Test",
      email: "luc_test@example.com",
      preferredLocale: "FR" as const,
      birthYear: 1971,
      gender: "M" as const,
      education: "BERUFSLEHRE" as const,
      postalCode: "1201",
      occupation: "Chef de chantier",
    },
    {
      // Moderations-Admin (P12.3): ohne ihn ist die Queue im E2E nicht
      // erreichbar. `isAdmin` wird ausschliesslich in der DB gesetzt — es gibt
      // bewusst kein UI, das jemanden zum Admin macht.
      id: "seed-admin",
      handle: "admin_test",
      name: "Admin Test",
      email: "admin_test@example.com",
      preferredLocale: "DE" as const,
      isAdmin: true,
    },
    {
      // Zweiter Admin für die A11y-Abnahme (P14.2). Grund ist nicht die Rolle,
      // sondern das Magic-Link-Limit: 5 Links je Adresse und 15 Minuten (P4).
      // Teilten sich alle Admin-Tests eine Adresse, wäre schon der zweite
      // Suite-Lauf innerhalb einer Viertelstunde rot — und zwar an einer
      // Rate-Limit-Bremse, die genau so funktioniert, wie sie soll.
      id: "seed-admin-2",
      handle: "admin2_test",
      name: "Admin Zwei",
      email: "admin2_test@example.com",
      preferredLocale: "DE" as const,
      isAdmin: true,
    },
  ];
  for (const u of users) {
    const { id, ...rest } = u;
    await prisma.user.upsert({
      where: { id },
      // Bestehende Dev-Datenbanken bekommen die neuen Felder ebenfalls.
      update: rest,
      create: u,
    });
  }

  const zurichBfs = 261; // Stadt Zürich

  await prisma.ticket.upsert({
    where: { id: "seed-ticket-1" },
    update: {},
    create: {
      id: "seed-ticket-1",
      authorId: "seed-user-1",
      level: "FEDERAL",
      originalLocale: "DE",
      hashtags: {
        connectOrCreate: [
          { where: { tag: "gesundheit" }, create: { tag: "gesundheit" } },
          { where: { tag: "praemien" }, create: { tag: "praemien" } },
        ],
      },
      translations: {
        create: [
          {
            locale: "DE",
            isOriginal: true,
            title: "Einheitliche Prämienverbilligung schweizweit harmonisieren",
            problem: tiptapDoc(
              "Die Prämienverbilligung wird in jedem Kanton anders berechnet. Haushalte mit gleichem Einkommen erhalten je nach Wohnort sehr unterschiedliche Unterstützung.",
            ),
            solution: tiptapDoc(
              "Der Bund definiert eine einheitliche Berechnungsgrundlage mit kantonalem Spielraum von maximal zehn Prozent.",
            ),
          },
          {
            locale: "FR",
            title: "Harmoniser la réduction des primes au niveau national",
            problem: tiptapDoc(
              "La réduction des primes est calculée différemment dans chaque canton. Des ménages au revenu identique reçoivent un soutien très variable selon leur domicile.",
            ),
            solution: tiptapDoc(
              "La Confédération définit une base de calcul uniforme avec une marge cantonale de dix pour cent au maximum.",
            ),
          },
          {
            locale: "IT",
            title: "Armonizzare la riduzione dei premi a livello nazionale",
            problem: tiptapDoc(
              "La riduzione dei premi è calcolata in modo diverso in ogni cantone. Famiglie con lo stesso reddito ricevono un sostegno molto diverso a seconda del domicilio.",
            ),
            solution: tiptapDoc(
              "La Confederazione definisce una base di calcolo uniforme con un margine cantonale massimo del dieci per cento.",
            ),
          },
        ],
      },
    },
  });

  await prisma.ticket.upsert({
    where: { id: "seed-ticket-2" },
    update: {},
    create: {
      id: "seed-ticket-2",
      authorId: "seed-user-2",
      level: "MUNICIPAL",
      municipalityId: zurichBfs,
      originalLocale: "FR",
      hashtags: {
        connectOrCreate: [
          { where: { tag: "verkehr" }, create: { tag: "verkehr" } },
        ],
      },
      translations: {
        create: [
          {
            locale: "FR",
            isOriginal: true,
            title: "Zones 30 devant toutes les écoles de la ville",
            problem: tiptapDoc(
              "Devant plusieurs écoles, la vitesse reste limitée à cinquante kilomètres par heure malgré un trafic dense aux heures d'entrée et de sortie des classes.",
            ),
            solution: tiptapDoc(
              "La ville introduit des zones 30 devant toutes les écoles et vérifie leur respect par des contrôles réguliers.",
            ),
          },
          {
            locale: "DE",
            title: "Tempo 30 vor allen Schulen der Stadt",
            problem: tiptapDoc(
              "Vor mehreren Schulen gilt weiterhin Tempo 50, obwohl zu Schulbeginn und Schulschluss dichter Verkehr herrscht.",
            ),
            solution: tiptapDoc(
              "Die Stadt führt vor allen Schulen Tempo-30-Zonen ein und prüft deren Einhaltung mit regelmässigen Kontrollen.",
            ),
          },
          {
            locale: "IT",
            title: "Zone 30 davanti a tutte le scuole della città",
            problem: tiptapDoc(
              "Davanti a diverse scuole vige ancora il limite di cinquanta chilometri orari, nonostante il traffico intenso all'inizio e alla fine delle lezioni.",
            ),
            solution: tiptapDoc(
              "La città introduce zone 30 davanti a tutte le scuole e ne verifica il rispetto con controlli regolari.",
            ),
          },
        ],
      },
    },
  });

  // Drittes Ticket für das T8-Board-Szenario: 8 Votes → im Consensus-Tab
  // ohne Rang («zu wenig Stimmen», N < 10).
  await prisma.ticket.upsert({
    where: { id: "seed-ticket-3" },
    update: {},
    create: {
      id: "seed-ticket-3",
      authorId: "seed-user-1",
      level: "CANTONAL",
      cantonId: 1, // Zürich
      originalLocale: "DE",
      hashtags: {
        connectOrCreate: [
          { where: { tag: "bildung" }, create: { tag: "bildung" } },
        ],
      },
      translations: {
        create: [
          {
            locale: "DE",
            isOriginal: true,
            title:
              "Informatikunterricht ab der Primarschule verbindlich machen",
            problem: tiptapDoc(
              "Der Informatikunterricht beginnt je nach Gemeinde zu unterschiedlichen Zeitpunkten. Viele Kinder erwerben digitale Grundkompetenzen erst spät oder gar nicht.",
            ),
            solution: tiptapDoc(
              "Der Kanton legt einen verbindlichen Start des Informatikunterrichts ab der dritten Primarklasse fest und stellt Weiterbildungen für Lehrpersonen bereit.",
            ),
          },
          {
            locale: "FR",
            title: "Rendre l'informatique obligatoire dès l'école primaire",
            problem: tiptapDoc(
              "L'enseignement de l'informatique commence à des moments différents selon les communes. Beaucoup d'enfants acquièrent les compétences numériques de base tardivement, voire pas du tout.",
            ),
            solution: tiptapDoc(
              "Le canton fixe un début obligatoire de l'enseignement de l'informatique dès la troisième année primaire et propose des formations continues aux enseignants.",
            ),
          },
          {
            locale: "IT",
            title: "Rendere obbligatoria l'informatica dalla scuola elementare",
            problem: tiptapDoc(
              "L'insegnamento dell'informatica inizia in momenti diversi a seconda del comune. Molti bambini acquisiscono le competenze digitali di base tardi o per niente.",
            ),
            solution: tiptapDoc(
              "Il cantone stabilisce un inizio vincolante dell'insegnamento dell'informatica dalla terza elementare e offre corsi di aggiornamento per i docenti.",
            ),
          },
        ],
      },
    },
  });

  // Viertes Ticket für das T10-PPR-Szenario: Autor ist seed-user-1 (anmeldbar),
  // Anträge stellen seed-user-2 und ein Wegwerf-User. Bewusst ohne Votes, damit
  // die Board-Reihenfolge der T8-Szenarien unberührt bleibt; der Lösungstext ist
  // > 200 Zeichen, damit die Vorbefüllung des Antragsformulars gültig startet.
  await prisma.ticket.upsert({
    where: { id: "seed-ticket-4" },
    update: {},
    create: {
      id: "seed-ticket-4",
      authorId: "seed-user-1",
      level: "FEDERAL",
      originalLocale: "DE",
      hashtags: {
        connectOrCreate: [
          { where: { tag: "mobilitaet" }, create: { tag: "mobilitaet" } },
        ],
      },
      translations: {
        create: [
          {
            locale: "DE",
            isOriginal: true,
            title: "Ladeinfrastruktur an Nationalstrassen einheitlich ausbauen",
            problem: tiptapDoc(
              "Die Ladestationen entlang der Nationalstrassen werden heute von verschiedenen Anbietern mit eigenen Abrechnungssystemen betrieben. Wer eine längere Fahrt plant, braucht mehrere Konten und findet vor Ort unterschiedliche Anschlüsse, Preise und Wartezeiten vor. Das bremst den Umstieg auf elektrische Antriebe.",
            ),
            solution: tiptapDoc(
              "Der Bund legt einen verbindlichen Mindeststandard für Ladestationen an Nationalstrassen fest: einheitliche Steckertypen, Bezahlung mit gängigen Karten ohne Vertragsbindung sowie eine öffentlich einsehbare Preisangabe pro Kilowattstunde. Die Umsetzung erfolgt gestaffelt über fünf Jahre und wird jährlich überprüft.",
            ),
          },
          {
            locale: "FR",
            title:
              "Développer une infrastructure de recharge uniforme sur les routes nationales",
            problem: tiptapDoc(
              "Les bornes de recharge le long des routes nationales sont exploitées par différents fournisseurs, chacun avec son propre système de facturation. Qui planifie un long trajet a besoin de plusieurs comptes et trouve sur place des prises, des prix et des temps d'attente différents. Cela freine le passage à la mobilité électrique.",
            ),
            solution: tiptapDoc(
              "La Confédération fixe une norme minimale contraignante pour les bornes de recharge sur les routes nationales : types de prises uniformes, paiement avec les cartes courantes sans abonnement, ainsi qu'un prix par kilowattheure affiché publiquement. La mise en œuvre est échelonnée sur cinq ans et vérifiée chaque année.",
            ),
          },
          {
            locale: "IT",
            title:
              "Sviluppare in modo uniforme l'infrastruttura di ricarica sulle strade nazionali",
            problem: tiptapDoc(
              "Le stazioni di ricarica lungo le strade nazionali sono gestite da fornitori diversi, ognuno con il proprio sistema di fatturazione. Chi pianifica un viaggio lungo ha bisogno di più conti e trova sul posto prese, prezzi e tempi di attesa differenti. Questo frena il passaggio alla mobilità elettrica.",
            ),
            solution: tiptapDoc(
              "La Confederazione fissa uno standard minimo vincolante per le stazioni di ricarica sulle strade nazionali: tipi di presa uniformi, pagamento con le carte più diffuse senza abbonamento e un prezzo per chilowattora indicato pubblicamente. L'attuazione avviene in modo scaglionato su cinque anni e viene verificata ogni anno.",
            ),
          },
        ],
      },
    },
  });

  // Fünftes Ticket als Träger für den T9-Statement-Flow. Eigenes Ticket, weil
  // jeder T9-Lauf echte Statements anlegt: läge das auf einem der T8-Score-
  // Szenarien (seed-ticket-1/-2/-3), würde deren Trending-Score (E = N + 2·S)
  // mitwachsen und die Board-Reihenfolge des T8-Tests kippen.
  await prisma.ticket.upsert({
    where: { id: "seed-ticket-5" },
    update: {},
    create: {
      id: "seed-ticket-5",
      authorId: "seed-user-2",
      level: "MUNICIPAL",
      municipalityId: zurichBfs,
      originalLocale: "DE",
      hashtags: {
        connectOrCreate: [
          { where: { tag: "quartier" }, create: { tag: "quartier" } },
        ],
      },
      translations: {
        create: [
          {
            locale: "DE",
            isOriginal: true,
            title: "Quartierhöfe für Nachbarschaftstreffen öffnen",
            problem: tiptapDoc(
              "Viele Innenhöfe der städtischen Liegenschaften stehen tagsüber leer, während Quartiervereine kaum bezahlbare Räume für Treffen finden. Die Zuständigkeiten sind auf mehrere Ämter verteilt, und eine Anfrage dauert oft mehrere Monate.",
            ),
            solution: tiptapDoc(
              "Die Stadt schafft eine zentrale Anlaufstelle mit einem einfachen Online-Formular für die Nutzung von Innenhöfen und veröffentlicht eine Liste der verfügbaren Flächen samt Bedingungen. Anfragen werden innerhalb von zwei Wochen beantwortet.",
            ),
          },
          {
            locale: "FR",
            title: "Ouvrir les cours de quartier aux rencontres de voisinage",
            problem: tiptapDoc(
              "De nombreuses cours intérieures des immeubles de la ville restent vides en journée, alors que les associations de quartier peinent à trouver des locaux abordables. Les compétences sont réparties entre plusieurs services et une demande prend souvent des mois.",
            ),
            solution: tiptapDoc(
              "La ville crée un guichet unique avec un formulaire en ligne simple pour l'utilisation des cours intérieures et publie une liste des surfaces disponibles avec leurs conditions. Les demandes reçoivent une réponse en deux semaines.",
            ),
          },
          {
            locale: "IT",
            title: "Aprire i cortili di quartiere agli incontri di vicinato",
            problem: tiptapDoc(
              "Molti cortili interni degli stabili comunali restano vuoti durante il giorno, mentre le associazioni di quartiere faticano a trovare spazi accessibili. Le competenze sono distribuite su più uffici e una richiesta richiede spesso mesi.",
            ),
            solution: tiptapDoc(
              "La città crea uno sportello unico con un semplice modulo online per l'uso dei cortili interni e pubblica un elenco delle superfici disponibili con le relative condizioni. Le richieste ricevono risposta entro due settimane.",
            ),
          },
        ],
      },
    },
  });

  // Sechstes Ticket als Träger für die Sicherheits-Tests (T13). Eigenes
  // Ticket aus demselben Grund wie seed-ticket-5, plus einem zweiten: die
  // XSS- und Rate-Limit-Specs laufen parallel zu moderation.spec, und beide
  // greifen auf "das erste Statement" ihres Tickets zu. Auf einem gemeinsamen
  // Träger würden sie sich gegenseitig die Karte unter dem Klick wegziehen.
  await prisma.ticket.upsert({
    where: { id: "seed-ticket-6" },
    update: {},
    create: {
      id: "seed-ticket-6",
      authorId: "seed-user-2",
      level: "MUNICIPAL",
      municipalityId: zurichBfs,
      originalLocale: "DE",
      hashtags: {
        connectOrCreate: [
          { where: { tag: "verwaltung" }, create: { tag: "verwaltung" } },
        ],
      },
      translations: {
        create: [
          {
            locale: "DE",
            isOriginal: true,
            title: "Formulare der Stadtverwaltung digital einreichbar machen",
            problem: tiptapDoc(
              "Viele Formulare der Stadtverwaltung müssen weiterhin ausgedruckt, unterschrieben und per Post eingereicht werden. Das verlängert die Bearbeitung um Tage und schliesst Menschen aus, die keinen Drucker haben.",
            ),
            solution: tiptapDoc(
              "Die Stadt stellt alle Formulare als ausfüllbare Online-Version bereit und akzeptiert eine elektronische Signatur. Der Postweg bleibt für alle bestehen, die ihn weiterhin nutzen möchten.",
            ),
          },
          {
            locale: "FR",
            title: "Rendre les formulaires de la ville déposables en ligne",
            problem: tiptapDoc(
              "De nombreux formulaires de l'administration municipale doivent encore être imprimés, signés et envoyés par la poste. Cela allonge le traitement de plusieurs jours et exclut les personnes sans imprimante.",
            ),
            solution: tiptapDoc(
              "La ville met tous les formulaires à disposition en version remplissable en ligne et accepte une signature électronique. La voie postale reste ouverte à toutes les personnes qui souhaitent continuer à l'utiliser.",
            ),
          },
          {
            locale: "IT",
            title: "Rendere i moduli comunali inoltrabili online",
            problem: tiptapDoc(
              "Molti moduli dell'amministrazione comunale devono ancora essere stampati, firmati e spediti per posta. Questo allunga di giorni il trattamento ed esclude chi non dispone di una stampante.",
            ),
            solution: tiptapDoc(
              "La città mette a disposizione tutti i moduli in versione compilabile online e accetta una firma elettronica. La via postale resta aperta a chi desidera continuare a usarla.",
            ),
          },
        ],
      },
    },
  });

  // seed-ticket-3 ist das interaktive E2E-Ticket: es braucht ECHTE Vote-Zeilen
  // (5↑/3↓ von 8 Seed-Votern), weil die Vote-Action die Zähler selbstheilend
  // aus der Tabelle zählt — reine Zähler würden beim ersten Vote überschrieben.
  const seedVotes: { userId: string; value: "UP" | "DOWN" }[] = Array.from(
    { length: 8 },
    (_, i) => ({
      userId: `seed-voter-${i + 1}`,
      value: i < 5 ? "UP" : "DOWN",
    }),
  );
  for (const [i, vote] of seedVotes.entries()) {
    await prisma.user.upsert({
      where: { id: vote.userId },
      update: {},
      create: {
        id: vote.userId,
        handle: `voter_test_${i + 1}`,
        preferredLocale: "DE",
      },
    });
    await prisma.ticketVote.upsert({
      where: {
        userId_ticketId: { userId: vote.userId, ticketId: "seed-ticket-3" },
      },
      update: { value: vote.value },
      create: {
        userId: vote.userId,
        ticketId: "seed-ticket-3",
        value: vote.value,
      },
    });
  }

  // T8-Score-Szenarien: Zähler + Scores denormalisiert (gleicher Rechenweg wie
  // die Vote-Actions, src/services/scoring.ts). seed-ticket-1/-2 bewusst OHNE
  // einzelne Vote-Zeilen — auf ihnen votet kein Test (Abweichungs-Log P8).
  // Consensus: seed-ticket-1 (425↑/75↓, Wilson ≈ 0.816) rankt über
  // seed-ticket-2 (5↑/0↓, Wilson ≈ 0.566); seed-ticket-3 bleibt ohne Rang.
  const ticketCounters = [
    {
      id: "seed-ticket-1",
      upvotes: 425,
      downvotes: 75,
      statementCount: 2,
      changeRequestCount: 0,
    },
    {
      id: "seed-ticket-2",
      upvotes: 5,
      downvotes: 0,
      statementCount: 0,
      changeRequestCount: 0,
    },
    {
      id: "seed-ticket-3",
      upvotes: 5,
      downvotes: 3,
      statementCount: 0,
      changeRequestCount: 0,
    },
  ];
  for (const counters of ticketCounters) {
    const { id, ...data } = counters;
    const { createdAt } = await prisma.ticket.findUniqueOrThrow({
      where: { id },
      select: { createdAt: true },
    });
    await prisma.ticket.update({
      where: { id },
      data: { ...data, ...computeTicketScores({ ...data, createdAt }) },
    });
  }

  const statements = [
    {
      id: "seed-statement-1",
      ticketId: "seed-ticket-1",
      authorId: "seed-user-2",
      category: "PRO" as const,
      originalLocale: "FR" as const,
      texts: {
        FR: "Une base uniforme rend le système plus équitable et plus transparent pour tous les ménages.",
        DE: "Eine einheitliche Grundlage macht das System für alle Haushalte gerechter und transparenter.",
        IT: "Una base uniforme rende il sistema più equo e trasparente per tutte le famiglie.",
      },
    },
    {
      id: "seed-statement-2",
      ticketId: "seed-ticket-1",
      authorId: "seed-user-1",
      category: "FRAGE" as const,
      originalLocale: "DE" as const,
      texts: {
        DE: "Wie würde der kantonale Spielraum von zehn Prozent konkret berechnet und überprüft?",
        FR: "Comment la marge cantonale de dix pour cent serait-elle calculée et contrôlée concrètement?",
        IT: "Come verrebbe calcolato e verificato concretamente il margine cantonale del dieci per cento?",
      },
    },
  ];

  for (const s of statements) {
    await prisma.statement.upsert({
      where: { id: s.id },
      update: {},
      create: {
        id: s.id,
        ticketId: s.ticketId,
        authorId: s.authorId,
        category: s.category,
        originalLocale: s.originalLocale,
        translations: {
          create: (
            Object.entries(s.texts) as ["DE" | "FR" | "IT", string][]
          ).map(([locale, text]) => ({
            locale,
            isOriginal: locale === s.originalLocale,
            content: tiptapDoc(text),
          })),
        },
      },
    });
  }
}

async function main() {
  const cantonCount = await seedCantons();
  const municipalityCount = await seedMunicipalities();
  if (process.env.NODE_ENV !== "production") {
    await seedDevData();
  }
  console.log(
    `Seed ok: ${cantonCount} Kantone, ${municipalityCount} Gemeinden` +
      (process.env.NODE_ENV !== "production"
        ? ", Dev-Testdaten (2 User, 6 Tickets inkl. Score-/PPR-/Statement-/Security-Szenarien, 2 Statements)"
        : ""),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
