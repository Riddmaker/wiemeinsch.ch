import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";

/**
 * Ticket-Card (Styleguide Art. 6): Ebenen-Chip (mono), Serif-Titel,
 * Mono-Hashtags, Fusszeile mit GETRENNTEN ▲/▼-Zahlen — ein verrechneter
 * Netto-Score ist verboten (auch in Tooltips/APIs).
 */

export type TicketCardData = {
  id: string;
  levelChip: string;
  title: string;
  hashtags: string[];
  upvotes: number;
  downvotes: number;
  statementCount: number;
  changeRequestCount: number;
};

export async function TicketCard({
  ticket,
  locale,
  tooFewVotes = false,
}: {
  ticket: TicketCardData;
  locale: AppLocale;
  /** Consensus-Tab: N < 10 → ohne Rang, Label «zu wenig Stimmen» (P8.4). */
  tooFewVotes?: boolean;
}) {
  const t = await getTranslations("board");
  const chNumber = new Intl.NumberFormat(`${locale}-CH`);

  return (
    <article
      data-testid="ticket-card"
      className="border border-line bg-paper px-5 py-[18px] pb-4 [&+&]:border-t-0"
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        <span className="inline-block rounded-[2px] border border-current px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-meta">
          {ticket.levelChip}
        </span>
        {tooFewVotes && (
          <span
            data-testid="too-few-votes"
            className="font-mono text-[11px] uppercase tracking-wide text-meta"
          >
            {t("tooFewVotes")}
          </span>
        )}
      </div>

      <h3 className="mb-1.5 font-serif text-[19px] font-bold leading-[1.35]">
        <Link
          href={`/tickets/${ticket.id}`}
          className="text-ink hover:underline"
        >
          {ticket.title}
        </Link>
      </h3>

      {ticket.hashtags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-3">
          {ticket.hashtags.map((tag) => (
            <span key={tag} className="font-mono text-[12.5px] text-meta">
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1 font-mono text-xs text-meta">
        <span className="inline-flex items-center gap-3.5 text-[13px]">
          <span className="font-bold text-pro">
            <span aria-hidden="true">▲ </span>
            <span className="sr-only">{t("upvotesAria")}: </span>
            {chNumber.format(ticket.upvotes)}
          </span>
          <span className="font-bold text-meta">
            <span aria-hidden="true">▼ </span>
            <span className="sr-only">{t("downvotesAria")}: </span>
            {chNumber.format(ticket.downvotes)}
          </span>
        </span>
        <span>{t("statements", { count: ticket.statementCount })}</span>
        <span>{t("changeRequests", { count: ticket.changeRequestCount })}</span>
      </div>
    </article>
  );
}
