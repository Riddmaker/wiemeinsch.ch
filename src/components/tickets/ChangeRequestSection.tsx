import { getTranslations } from "next-intl/server";
import { ChangeRequestCard } from "@/components/tickets/ChangeRequestCard";
import { ChangeRequestForm } from "@/components/tickets/ChangeRequestForm";
import type { AppLocale } from "@/i18n/routing";
import { sortForDisplay, type ChangeRequestEntry } from "@/lib/change-requests";
import type { CurrentTicketVersion } from "@/components/tickets/ChangeRequestCard";

/**
 * Political-Pull-Request-Abschnitt der Detailseite (P10.1/10.2): Antragsformular
 * für alle ausser dem Original-Autor, darunter die öffentliche Liste aller
 * Anträge (offene zuerst) mit Gegenüberstellung alt/neu.
 */
export async function ChangeRequestSection({
  ticketId,
  entries,
  current,
  contentLocale,
  routeLocale,
  isAuthor,
  viewerId,
}: {
  ticketId: string;
  entries: ChangeRequestEntry[];
  /** Aktuelle Ticket-Fassung in der Lese-Sprache (Vorbefüllung + Vergleich). */
  current: CurrentTicketVersion;
  /** Lese-/Schreibsprache des Betrachters. */
  contentLocale: AppLocale;
  routeLocale: AppLocale;
  isAuthor: boolean;
  viewerId: string | null;
}) {
  const t = await getTranslations("changeRequests");
  const sorted = sortForDisplay(entries);
  const openCount = entries.filter((entry) => entry.status === "OPEN").length;
  // Pro User genau ein offener Antrag (gleiche Regel wie in der Action).
  const hasOwnOpenRequest = entries.some(
    (entry) => entry.status === "OPEN" && entry.authorId === viewerId,
  );

  return (
    <section className="mt-12" data-testid="change-request-section">
      <h2 className="mb-1 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta">
        {t("heading", { count: entries.length })}
      </h2>

      {isAuthor ? (
        <p
          data-testid="change-request-author-hint"
          className="mt-3 font-mono text-xs text-meta"
        >
          {openCount > 0
            ? t("authorOpenHint", { count: openCount })
            : t("authorEmptyHint")}
        </p>
      ) : hasOwnOpenRequest ? (
        <p
          data-testid="change-request-own-open"
          className="mt-3 font-mono text-xs text-meta"
        >
          {t("errors.duplicate_open")}
        </p>
      ) : (
        <>
          <p className="mt-3 text-[15px] leading-relaxed">{t("intro")}</p>
          <div className="flex flex-col">
            <ChangeRequestForm
              ticketId={ticketId}
              contentLocale={contentLocale}
              current={current}
              isLoggedIn={viewerId !== null}
            />
          </div>
        </>
      )}

      {sorted.length === 0 ? (
        <p className="mt-4 font-mono text-xs text-meta">{t("empty")}</p>
      ) : (
        <div className="mt-6 flex flex-col gap-3.5">
          {sorted.map((entry) => (
            <ChangeRequestCard
              key={entry.id}
              entry={entry}
              current={current}
              locale={routeLocale}
              isTicketAuthor={isAuthor}
            />
          ))}
        </div>
      )}
    </section>
  );
}
