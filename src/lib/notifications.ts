import type { AppLocale } from "@/i18n/routing";
import { prisma } from "@/lib/prisma";
import { pickTranslation } from "@/lib/translations";

/**
 * Benachrichtigungen (E14, 04.09.2026).
 *
 * Bewusst OHNE Ereignistabelle: Angezeigt werden die aktuellen
 * GESAMTZAHLEN, nicht Deltas. Damit genügt ein einziger Zeitstempel
 * (`User.notificationsReadAt`), um «gibt es Neues?» zu beantworten — es muss
 * nichts pro Ereignis nachgehalten werden, und «alles gelesen» ist ein
 * einzelnes UPDATE.
 *
 * Der Preis: Nach einer einzigen neuen Stimme steht dort trotzdem der volle
 * Stand. Die Beschriftung sagt das auch so («dein aktueller Stand»), statt
 * eine Zahl als «neu» auszugeben, die es nicht ist.
 *
 * Auslöser sind Reaktionen auf eigene Tickets UND eigene Statements sowie
 * Statements und Änderungsanträge auf eigene Tickets (User-Entscheid).
 * Eigene Beiträge zählen nie — sonst benachrichtigte die eigene Stimme.
 */

export type NotificationSummary = {
  /** Zustimmungen/Ablehnungen auf eigene Tickets und Statements zusammen. */
  reactions: { up: number; down: number } | null;
  /** Statements auf eigenen Tickets, nach Kategorie. */
  statements: Record<"PRO" | "CONTRA" | "ERWEITERUNG" | "FRAGE", number> | null;
  /** Offene Änderungsanträge auf eigenen Tickets. */
  changeRequests: number | null;
  /** Betroffene Tickets (Titel in der Lese-Sprache) für die Sprungliste. */
  tickets: { id: string; title: string }[];
};

/** Obergrenze für die Sprungliste — sie soll orientieren, nicht erschlagen. */
const MAX_AFFECTED = 20;

/** Leeres Ergebnis — nichts anzuzeigen. */
const NOTHING: NotificationSummary = {
  reactions: null,
  statements: null,
  changeRequests: null,
  tickets: [],
};

/**
 * Gibt es seit der letzten Lesemarke irgendein Ereignis?
 *
 * Läuft im Header bei JEDEM Seitenaufruf, deshalb vier schlanke
 * Existenz-Abfragen mit `take: 1` statt Zählungen — die Antwort ist ein
 * Boolean, die genaue Zahl interessiert hier niemanden.
 */
export async function hasUnreadNotifications(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationsReadAt: true },
  });
  if (!user) {
    return false;
  }
  // NULL = noch nie gelesen: dann zählt alles, was je passiert ist.
  const since = user.notificationsReadAt ?? new Date(0);
  const newer = { gt: since };

  const [ticketVote, statementVote, statement, changeRequest] =
    await Promise.all([
      prisma.ticketVote.findFirst({
        where: {
          updatedAt: newer,
          ticket: { authorId: userId },
          userId: { not: userId },
        },
        select: { id: true },
      }),
      prisma.statementVote.findFirst({
        where: {
          updatedAt: newer,
          statement: { authorId: userId },
          userId: { not: userId },
        },
        select: { id: true },
      }),
      prisma.statement.findFirst({
        where: {
          createdAt: newer,
          status: "PUBLISHED",
          authorId: { not: userId },
          ticket: { authorId: userId },
        },
        select: { id: true },
      }),
      prisma.changeRequest.findFirst({
        where: {
          createdAt: newer,
          ticket: { authorId: userId },
        },
        select: { id: true },
      }),
    ]);

  return Boolean(ticketVote ?? statementVote ?? statement ?? changeRequest);
}

/**
 * Vollständige Übersicht für die eigene Profilseite.
 *
 * Je Kategorie wird zuerst geprüft, ob es dort etwas Neues gibt; nur dann
 * werden die Gesamtzahlen gerechnet. Eine Kategorie ohne Neuigkeit bleibt
 * `null` und wird gar nicht gerendert.
 */
export async function loadNotifications(
  userId: string,
  displayLocale: AppLocale,
): Promise<NotificationSummary> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationsReadAt: true },
  });
  if (!user) {
    return NOTHING;
  }
  const since = user.notificationsReadAt ?? new Date(0);
  const newer = { gt: since };

  const myTickets = await prisma.ticket.findMany({
    where: { authorId: userId, status: "PUBLISHED" },
    select: { id: true, upvotes: true, downvotes: true },
  });
  const myTicketIds = myTickets.map((ticket) => ticket.id);

  const [
    newTicketVotes,
    newStatementVotes,
    newStatements,
    newChangeRequests,
    myStatements,
  ] = await Promise.all([
    // `distinct` statt `findFirst`: Für die Sprungliste zählt JEDES
    // betroffene Ticket, nicht nur das erste.
    prisma.ticketVote.findMany({
      where: {
        updatedAt: newer,
        ticketId: { in: myTicketIds },
        userId: { not: userId },
      },
      select: { ticketId: true },
      distinct: ["ticketId"],
      take: MAX_AFFECTED,
    }),
    prisma.statementVote.findMany({
      where: {
        updatedAt: newer,
        statement: { authorId: userId },
        userId: { not: userId },
      },
      select: { statement: { select: { ticketId: true } } },
      take: MAX_AFFECTED,
    }),
    prisma.statement.findMany({
      where: {
        createdAt: newer,
        status: "PUBLISHED",
        authorId: { not: userId },
        ticketId: { in: myTicketIds },
      },
      select: { ticketId: true },
    }),
    prisma.changeRequest.findMany({
      where: { createdAt: newer, ticketId: { in: myTicketIds } },
      select: { ticketId: true },
    }),
    prisma.statement.findMany({
      where: { authorId: userId, status: "PUBLISHED" },
      select: { id: true, upvotes: true, downvotes: true, ticketId: true },
    }),
  ]);

  const hasNewReaction =
    newTicketVotes.length > 0 || newStatementVotes.length > 0;
  const hasNewStatements = newStatements.length > 0;
  const hasNewChangeRequests = newChangeRequests.length > 0;

  if (!hasNewReaction && !hasNewStatements && !hasNewChangeRequests) {
    return NOTHING;
  }

  // Gesamtstand aus den denormalisierten Zählern — kein Live-Aggregat.
  const reactions = hasNewReaction
    ? [...myTickets, ...myStatements].reduce(
        (sum, item) => ({
          up: sum.up + item.upvotes,
          down: sum.down + item.downvotes,
        }),
        { up: 0, down: 0 },
      )
    : null;

  let statements: NotificationSummary["statements"] = null;
  if (hasNewStatements) {
    const grouped = await prisma.statement.groupBy({
      by: ["category"],
      where: {
        status: "PUBLISHED",
        authorId: { not: userId },
        ticketId: { in: myTicketIds },
      },
      _count: { _all: true },
    });
    statements = { PRO: 0, CONTRA: 0, ERWEITERUNG: 0, FRAGE: 0 };
    for (const row of grouped) {
      statements[row.category] = row._count._all;
    }
  }

  const changeRequests = hasNewChangeRequests
    ? await prisma.changeRequest.count({
        where: { ticketId: { in: myTicketIds }, status: "OPEN" },
      })
    : null;

  // Betroffene Tickets: alles, worauf sich eine der Neuigkeiten bezieht.
  const affected = new Set<string>();
  for (const row of [
    ...newTicketVotes,
    ...newStatements,
    ...newChangeRequests,
  ]) {
    affected.add(row.ticketId);
  }
  for (const row of newStatementVotes) {
    affected.add(row.statement.ticketId);
  }

  const tickets =
    affected.size > 0
      ? (
          await prisma.ticket.findMany({
            where: { id: { in: [...affected] } },
            select: {
              id: true,
              translations: {
                select: { locale: true, title: true, isOriginal: true },
              },
            },
          })
        ).map((ticket) => ({
          id: ticket.id,
          title:
            pickTranslation(ticket.translations, displayLocale)?.title ?? "",
        }))
      : [];

  return { reactions, statements, changeRequests, tickets };
}
