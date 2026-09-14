import { getTranslations } from "next-intl/server";
import { ReportButton } from "@/components/moderation/ReportButton";
import { AuthorLink } from "@/components/profile/AuthorLink";
import { RichTextView } from "@/components/tickets/RichTextView";
import { VoteButtons } from "@/components/tickets/VoteButtons";
import type { AppLocale } from "@/i18n/routing";
import type { StatementCategory } from "@/lib/validation/statement";
import type { VoteChoice } from "@/lib/validation/vote";

/**
 * Statement-Card (P9.2, Styleguide Art. 7): Kategorie erscheint doppelt —
 * farbige 4px-Linksborder UND beschrifteter Chip (Farbe nie alleiniger
 * Träger). Einzige Interaktion: ▲/▼ getrennt — KEINE Antworten.
 */

export type StatementCardData = {
  id: string;
  category: StatementCategory;
  authorId: string;
  authorHandle: string | null;
  createdAt: Date;
  /** Anzuzeigende Fassung (Anzeige-Sprache oder Original-Fallback). */
  doc: unknown;
  originalLocale: AppLocale;
  isTranslated: boolean;
  upvotes: number;
  downvotes: number;
  myVote: VoteChoice | null;
};

/** Farb-Semantik strikt: CONTRA = Bundesrot, PRO = Pro-Grün, Rest = Meta-Grau. */
const CATEGORY_STYLES: Record<
  StatementCategory,
  { border: string; chip: string; symbol: string }
> = {
  PRO: { border: "border-l-pro", chip: "text-pro", symbol: "＋" },
  CONTRA: { border: "border-l-contra", chip: "text-contra", symbol: "−" },
  ERWEITERUNG: { border: "border-l-meta", chip: "text-meta", symbol: "≡" },
  FRAGE: { border: "border-l-meta", chip: "text-meta", symbol: "?" },
};

export async function StatementCard({
  statement,
  locale,
  isLoggedIn,
}: {
  statement: StatementCardData;
  locale: AppLocale;
  isLoggedIn: boolean;
}) {
  const t = await getTranslations("statements");
  const tRoot = await getTranslations();
  const styles = CATEGORY_STYLES[statement.category];

  const dateFormat = new Intl.DateTimeFormat(`${locale}-CH`, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  return (
    <article
      data-testid="statement-card"
      data-category={statement.category}
      className={`max-w-[640px] border border-line border-l-4 ${styles.border} bg-paper px-[18px] py-3.5`}
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={`inline-block rounded-[2px] border border-current px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.07em] ${styles.chip}`}
        >
          <span aria-hidden="true">{styles.symbol} </span>
          {t(`categories.${statement.category}`)}
        </span>
        <span className="font-mono text-[11.5px] text-meta">
          {statement.authorHandle && (
            <>
              <AuthorLink
                userId={statement.authorId}
                handle={statement.authorHandle}
              />
              {" · "}
            </>
          )}
          {dateFormat.format(statement.createdAt)}
          {statement.isTranslated &&
            ` · ${t("original", {
              language: tRoot(`localeSwitcher.${statement.originalLocale}`),
            })} · ${t("aiTranslated")}`}
        </span>
        {/* Melden (P12.1): gleiche stille Behandlung wie beim Ticket. */}
        <ReportButton
          target={{ kind: "statement", id: statement.id }}
          isLoggedIn={isLoggedIn}
        />
      </div>

      <RichTextView
        doc={statement.doc}
        className="mb-3 font-serif text-[15px] leading-[1.65] [&_p]:mb-2.5 [&_p:last-child]:mb-0 [&_ul]:mb-2.5 [&_ul]:list-disc [&_ul]:pl-5"
      />

      <VoteButtons
        target={{ kind: "statement", id: statement.id }}
        initialUpvotes={statement.upvotes}
        initialDownvotes={statement.downvotes}
        initialMyVote={statement.myVote}
        isLoggedIn={isLoggedIn}
        compact
      />
    </article>
  );
}
