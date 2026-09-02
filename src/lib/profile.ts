import type { AppLocale } from "@/i18n/routing";
import { prisma } from "@/lib/prisma";
import { regionName } from "@/lib/ticket-display";
import { pickTranslation } from "@/lib/translations";
import { publicUserSelect, type PublicUser } from "@/lib/user-projection";
import type { StatementCategory } from "@/lib/validation/statement";
import type { VoteChoice } from "@/lib/validation/vote";

/**
 * Öffentliches Profil (P11.4): Abstimmungshistorie und Beiträge eines Users.
 *
 * Datenschutz (nDSG): Alle Userdaten kommen
 * ausschliesslich über `publicUserSelect` — die demografischen Spalten werden
 * hier nie selektiert und können deshalb auch nicht versehentlich in die
 * RSC-Antwort geraten. Ein dauerhafter Test scannt die Antwort gegenzu (T11).
 */

/** MVP ohne Pagination — Obergrenze je Liste (wie beim Board, P8.4). */
const PROFILE_LIST_SIZE = 50;

export type ProfileTicketEntry = {
  id: string;
  title: string;
  level: "FEDERAL" | "CANTONAL" | "MUNICIPAL";
  region: string | null;
  createdAt: Date;
};

export type ProfileStatementEntry = {
  id: string;
  ticketId: string;
  ticketTitle: string;
  category: StatementCategory;
  createdAt: Date;
};

export type ProfileVoteEntry = {
  ticketId: string;
  ticketTitle: string;
  value: VoteChoice;
  createdAt: Date;
};

export type ProfileData = {
  user: PublicUser;
  tickets: ProfileTicketEntry[];
  coAuthoredTickets: ProfileTicketEntry[];
  statements: ProfileStatementEntry[];
  upvotedTickets: ProfileVoteEntry[];
  downvotedTickets: ProfileVoteEntry[];
};

const ticketInclude = {
  translations: {
    select: { locale: true, title: true, isOriginal: true },
  },
  canton: { select: { nameDe: true, nameFr: true, nameIt: true } },
  municipality: { select: { name: true } },
} as const;

type TicketRow = {
  id: string;
  level: "FEDERAL" | "CANTONAL" | "MUNICIPAL";
  createdAt: Date;
  translations: {
    locale: "DE" | "FR" | "IT";
    title: string;
    isOriginal: boolean;
  }[];
  canton: { nameDe: string; nameFr: string; nameIt: string } | null;
  municipality: { name: string } | null;
};

function toTicketEntry(
  ticket: TicketRow,
  displayLocale: AppLocale,
  routeLocale: AppLocale,
): ProfileTicketEntry {
  const version = pickTranslation(ticket.translations, displayLocale);
  return {
    id: ticket.id,
    title: version?.title ?? "",
    level: ticket.level,
    region: regionName(ticket, routeLocale),
    createdAt: ticket.createdAt,
  };
}

/**
 * Lädt das öffentliche Profil in einer Runde. Gibt `null` zurück, wenn es den
 * User nicht gibt — die Seite antwortet dann mit 404 (kein Unterschied
 * zwischen «gibt es nicht» und «hat nichts gemacht»).
 */
export async function loadProfile(opts: {
  userId: string;
  displayLocale: AppLocale;
  routeLocale: AppLocale;
}): Promise<ProfileData | null> {
  const { userId, displayLocale, routeLocale } = opts;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: publicUserSelect,
  });
  if (!user) {
    return null;
  }

  const [tickets, coAuthored, statements, votes] = await Promise.all([
    prisma.ticket.findMany({
      where: { authorId: userId, status: "PUBLISHED" },
      orderBy: { createdAt: "desc" },
      take: PROFILE_LIST_SIZE,
      select: { id: true, level: true, createdAt: true, ...ticketInclude },
    }),
    prisma.ticket.findMany({
      where: { coAuthors: { some: { id: userId } }, status: "PUBLISHED" },
      orderBy: { createdAt: "desc" },
      take: PROFILE_LIST_SIZE,
      select: { id: true, level: true, createdAt: true, ...ticketInclude },
    }),
    prisma.statement.findMany({
      where: { authorId: userId, status: "PUBLISHED" },
      orderBy: { createdAt: "desc" },
      take: PROFILE_LIST_SIZE,
      select: {
        id: true,
        category: true,
        createdAt: true,
        ticketId: true,
        ticket: {
          select: {
            status: true,
            translations: {
              select: { locale: true, title: true, isOriginal: true },
            },
          },
        },
      },
    }),
    prisma.ticketVote.findMany({
      where: { userId, ticket: { status: "PUBLISHED" } },
      orderBy: { createdAt: "desc" },
      take: PROFILE_LIST_SIZE * 2,
      select: {
        value: true,
        createdAt: true,
        ticketId: true,
        ticket: {
          select: {
            translations: {
              select: { locale: true, title: true, isOriginal: true },
            },
          },
        },
      },
    }),
  ]);

  const voteEntries: ProfileVoteEntry[] = votes.map((vote) => ({
    ticketId: vote.ticketId,
    ticketTitle:
      pickTranslation(vote.ticket.translations, displayLocale)?.title ?? "",
    value: vote.value,
    createdAt: vote.createdAt,
  }));

  return {
    user,
    tickets: tickets.map((ticket) =>
      toTicketEntry(ticket, displayLocale, routeLocale),
    ),
    coAuthoredTickets: coAuthored.map((ticket) =>
      toTicketEntry(ticket, displayLocale, routeLocale),
    ),
    statements: statements
      .filter((statement) => statement.ticket.status === "PUBLISHED")
      .map((statement) => ({
        id: statement.id,
        ticketId: statement.ticketId,
        ticketTitle:
          pickTranslation(statement.ticket.translations, displayLocale)
            ?.title ?? "",
        category: statement.category as StatementCategory,
        createdAt: statement.createdAt,
      })),
    upvotedTickets: voteEntries.filter((vote) => vote.value === "UP"),
    downvotedTickets: voteEntries.filter((vote) => vote.value === "DOWN"),
  };
}

/**
 * Offene Änderungsanträge auf den eigenen Tickets (P10.2, im Profil
 * nachgeholt): nur für den eigenen Blick auf das Profil — ein Fremder sieht
 * die Zahl nicht, sie gehört zur eigenen Arbeitsliste.
 */
export async function countOpenChangeRequestsForAuthor(
  userId: string,
): Promise<number> {
  return prisma.changeRequest.count({
    where: {
      status: "OPEN",
      ticket: { authorId: userId, status: "PUBLISHED" },
    },
  });
}
