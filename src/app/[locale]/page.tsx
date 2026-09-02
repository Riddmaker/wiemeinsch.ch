import { getTranslations } from "next-intl/server";
import {
  TicketCard,
  type TicketCardData,
} from "@/components/tickets/TicketCard";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { getDisplayLocale } from "@/lib/display-locale";
import { prisma } from "@/lib/prisma";
import { regionName } from "@/lib/ticket-display";
import { pickTranslation } from "@/lib/translations";
import { CONSENSUS_MIN_VOTES } from "@/services/scoring";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Das Board (P8.4, Styleguide Art. 6): drei Tabs, Sortierung = indexierter
 * ORDER BY auf den denormalisierten Score-Spalten (kein Live-Aggregat).
 * Consensus: Tickets mit N < 10 ohne Rang unterhalb, Label «zu wenig Stimmen».
 */

const TABS = ["trending", "consensus", "controversial"] as const;
type BoardTab = (typeof TABS)[number];

const TAB_ORDER: Record<BoardTab, Prisma.TicketOrderByWithRelationInput> = {
  trending: { scoreTrending: "desc" },
  consensus: { scoreConsensus: "desc" },
  controversial: { scoreControversy: "desc" },
};

/** MVP ohne Pagination — Obergrenze für die Board-Abfrage. */
const BOARD_SIZE = 50;

export default async function BoardPage({
  params,
  searchParams,
}: PageProps<"/[locale]">) {
  const { locale } = await params;
  const sp = await searchParams;
  const tabParam = typeof sp.tab === "string" ? sp.tab : "";
  const tab: BoardTab = (TABS as readonly string[]).includes(tabParam)
    ? (tabParam as BoardTab)
    : "trending";

  const t = await getTranslations("board");
  const tHome = await getTranslations("home");
  const tRoot = await getTranslations();
  const { displayLocale } = await getDisplayLocale(locale as AppLocale);

  const tickets = await prisma.ticket.findMany({
    where: { status: "PUBLISHED" },
    orderBy: [TAB_ORDER[tab], { createdAt: "desc" }],
    take: BOARD_SIZE,
    include: {
      translations: { select: { locale: true, title: true, isOriginal: true } },
      hashtags: { orderBy: { tag: "asc" }, select: { tag: true } },
      canton: { select: { nameDe: true, nameFr: true, nameIt: true } },
      municipality: { select: { name: true } },
    },
  });

  const cards: (TicketCardData & { voteCount: number })[] = tickets.map(
    (ticket) => {
      const version = pickTranslation(ticket.translations, displayLocale);
      const region = regionName(ticket, locale as AppLocale);
      return {
        id: ticket.id,
        levelChip: region
          ? `${tRoot(`levels.${ticket.level}`)} · ${region}`
          : tRoot(`levels.${ticket.level}`),
        title: version?.title ?? "",
        hashtags: ticket.hashtags.map((h) => h.tag),
        upvotes: ticket.upvotes,
        downvotes: ticket.downvotes,
        statementCount: ticket.statementCount,
        changeRequestCount: ticket.changeRequestCount,
        voteCount: ticket.upvotes + ticket.downvotes,
      };
    },
  );

  // Consensus: N < 10 hat keinen Rang — unterhalb der gerankten Liste zeigen.
  // (Partition statt SQL-Filter: Prisma kann nicht auf upvotes+downvotes
  // filtern; die Score-Reihenfolge innerhalb beider Gruppen bleibt erhalten.)
  const ranked =
    tab === "consensus"
      ? cards.filter((card) => card.voteCount >= CONSENSUS_MIN_VOTES)
      : cards;
  const unranked =
    tab === "consensus"
      ? cards.filter((card) => card.voteCount < CONSENSUS_MIN_VOTES)
      : [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight sm:text-4xl">
        {tHome("title")}
      </h1>
      <p className="mt-4 max-w-[60ch] font-serif text-lg leading-relaxed text-ink">
        {tHome("intro")}
      </p>

      <nav
        aria-label={t("tabsAria")}
        className="mt-10 flex gap-1 border-b-2 border-ink"
      >
        {TABS.map((key) => (
          <Link
            key={key}
            data-testid={`tab-${key}`}
            href={
              key === "trending" ? "/" : { pathname: "/", query: { tab: key } }
            }
            aria-current={key === tab ? "page" : undefined}
            className={`px-4 pb-[9px] pt-2.5 font-mono text-[12.5px] font-bold uppercase tracking-[0.06em] ${
              key === tab ? "bg-ink text-paper" : "text-meta hover:text-ink"
            }`}
          >
            {t(`tabs.${key}`)}
          </Link>
        ))}
      </nav>

      {cards.length === 0 && (
        <p className="mt-6 border border-line bg-surface px-4 py-3 font-mono text-xs text-meta">
          {t("empty")}
        </p>
      )}

      <div className="mt-6">
        {ranked.map((card) => (
          <TicketCard
            key={card.id}
            ticket={card}
            locale={locale as AppLocale}
          />
        ))}
      </div>

      {unranked.length > 0 && (
        <div className="mt-6">
          {unranked.map((card) => (
            <TicketCard
              key={card.id}
              ticket={card}
              locale={locale as AppLocale}
              tooFewVotes
            />
          ))}
        </div>
      )}
    </div>
  );
}
