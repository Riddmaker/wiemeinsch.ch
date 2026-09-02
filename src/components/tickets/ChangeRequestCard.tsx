import { getTranslations } from "next-intl/server";
import { ChangeRequestDecision } from "@/components/tickets/ChangeRequestDecision";
import { RichTextView } from "@/components/tickets/RichTextView";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import type {
  ChangeRequestEntry,
  ChangeRequestStatus,
} from "@/lib/change-requests";

/**
 * Ein Änderungsantrag (P10.2): Meta-Zeile (mono) + Gegenüberstellung
 * alt/neu als zwei gerenderte Blöcke — mobil untereinander, ab `sm`
 * nebeneinander. Farbe bleibt den Statements vorbehalten (Styleguide Art. 5),
 * der Status ist deshalb schwarz-weiss ausgezeichnet.
 */

const STATUS_CHIP: Record<ChangeRequestStatus, string> = {
  OPEN: "border-ink text-ink",
  MERGED: "border-ink bg-ink text-paper",
  DECLINED: "border-line text-meta",
};

const RICH_TEXT_CLASSES =
  "font-serif text-[15.5px] leading-[1.7] [&_p]:mb-2 [&_ul]:mb-2 " +
  "[&_ul]:list-disc [&_ul]:pl-5";

export async function ChangeRequestCard({
  entry,
  currentSolution,
  locale,
  isTicketAuthor,
}: {
  entry: ChangeRequestEntry;
  /** Aktueller Lösungstext in der Lese-Sprache — die «alte» Fassung. */
  currentSolution: unknown;
  /** Locale der Route — Datumsformat. */
  locale: AppLocale;
  isTicketAuthor: boolean;
}) {
  const t = await getTranslations("changeRequests");
  const tRoot = await getTranslations();

  const dateFormat = new Intl.DateTimeFormat(`${locale}-CH`, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  return (
    <article
      data-testid="change-request-card"
      data-status={entry.status}
      className="border border-line bg-paper p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-[11.5px] uppercase tracking-[0.03em] text-meta">
        <span className="font-bold text-ink">
          {t("number", { number: entry.number })}
        </span>
        <span
          data-testid="change-request-status"
          className={`inline-block rounded-[2px] border px-2 py-0.5 font-bold ${STATUS_CHIP[entry.status]}`}
        >
          {t(`status.${entry.status}`)}
        </span>
        {entry.authorHandle && (
          <Link
            href={`/profil/${entry.authorId}`}
            className="underline underline-offset-2 hover:text-ink"
          >
            {t("by", { handle: entry.authorHandle })}
          </Link>
        )}
        <span>
          {t("submitted", { date: dateFormat.format(entry.createdAt) })}
        </span>
        {entry.decidedAt && (
          <span>
            {t("decided", { date: dateFormat.format(entry.decidedAt) })}
          </span>
        )}
        <span>
          {t("original", {
            language: tRoot(`localeSwitcher.${entry.originalLocale}`),
          })}
          {entry.isTranslated && ` · ${t("aiTranslated")}`}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <section>
          <h3 className="mb-2 border-b border-line pb-1 font-mono text-[11px] font-bold uppercase tracking-wide text-meta">
            {t("currentSolution")}
          </h3>
          <RichTextView doc={currentSolution} className={RICH_TEXT_CLASSES} />
        </section>
        <section data-testid="change-request-proposal">
          <h3 className="mb-2 border-b border-line pb-1 font-mono text-[11px] font-bold uppercase tracking-wide text-meta">
            {t("proposedSolution")}
          </h3>
          <RichTextView doc={entry.displayDoc} className={RICH_TEXT_CLASSES} />
        </section>
      </div>

      {isTicketAuthor && entry.status === "OPEN" && entry.versions && (
        <ChangeRequestDecision
          changeRequestId={entry.id}
          proposedVersions={entry.versions}
          isStale={entry.isStale}
        />
      )}
    </article>
  );
}
