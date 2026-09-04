import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { NotificationPanel } from "@/components/profile/NotificationPanel";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { getDisplayLocale } from "@/lib/display-locale";
import { loadNotifications } from "@/lib/notifications";
import {
  loadOpenChangeRequestsForAuthor,
  loadProfile,
  type ProfileStatementEntry,
  type ProfileTicketEntry,
  type ProfileVoteEntry,
} from "@/lib/profile";

/**
 * Öffentliches Profil (P11.4):
 * Abstimmungshistorie und Beiträge sind für alle sichtbar — auch ausgeloggt.
 * Demografische Angaben erscheinen hier NIE; die Seite lädt sie gar nicht
 * erst (loadProfile nutzt ausschliesslich die öffentliche Projektion).
 */

const SECTION_HEADING =
  "mb-3 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta";
const ROW =
  "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line py-2.5 last:border-b-0";
const ROW_TITLE = "font-serif text-[15.5px] leading-snug hover:underline";
const ROW_META =
  "font-mono text-[11.5px] uppercase tracking-[0.03em] text-meta";

export default async function ProfilePage({
  params,
}: PageProps<"/[locale]/profil/[id]">) {
  const { locale, id } = await params;
  const t = await getTranslations("profile");
  const tRoot = await getTranslations();

  const { displayLocale, userId } = await getDisplayLocale(locale as AppLocale);
  const profile = await loadProfile({
    userId: id,
    displayLocale,
    routeLocale: locale as AppLocale,
  });
  if (!profile) {
    notFound();
  }

  const isSelf = userId === profile.user.id;
  const openChangeRequests = isSelf
    ? await loadOpenChangeRequestsForAuthor(profile.user.id, displayLocale)
    : { total: 0, tickets: [] };
  // Benachrichtigungen NUR für den Profilinhaber — /profil/[id] ist öffentlich.
  const notifications = isSelf
    ? await loadNotifications(profile.user.id, displayLocale)
    : null;

  const dateFormat = new Intl.DateTimeFormat(`${locale}-CH`, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const levelChip = (entry: ProfileTicketEntry): string =>
    entry.region
      ? `${tRoot(`levels.${entry.level}`)} · ${entry.region}`
      : tRoot(`levels.${entry.level}`);

  const ticketRows = (entries: ProfileTicketEntry[], emptyText: string) =>
    entries.length === 0 ? (
      <p className="font-mono text-xs text-meta">{emptyText}</p>
    ) : (
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className={ROW}>
            <Link href={`/tickets/${entry.id}`} className={ROW_TITLE}>
              {entry.title}
            </Link>
            <span className={ROW_META}>
              {levelChip(entry)} · {dateFormat.format(entry.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    );

  const statementRows = (entries: ProfileStatementEntry[]) =>
    entries.length === 0 ? (
      <p className="font-mono text-xs text-meta">{t("emptyStatements")}</p>
    ) : (
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className={ROW}>
            <Link href={`/tickets/${entry.ticketId}`} className={ROW_TITLE}>
              {entry.ticketTitle}
            </Link>
            <span className={ROW_META}>
              {tRoot(`statements.categories.${entry.category}`)} ·{" "}
              {dateFormat.format(entry.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    );

  const voteRows = (entries: ProfileVoteEntry[]) =>
    entries.length === 0 ? (
      <p className="font-mono text-xs text-meta">{t("emptyVotes")}</p>
    ) : (
      <ul>
        {entries.map((entry) => (
          <li key={entry.ticketId} className={ROW}>
            <Link href={`/tickets/${entry.ticketId}`} className={ROW_TITLE}>
              {entry.ticketTitle}
            </Link>
            <span className={ROW_META}>
              {dateFormat.format(entry.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    );

  return (
    <div
      className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14"
      data-testid="profile-page"
    >
      <h1
        className="font-serif text-[28px] font-bold leading-[1.3] sm:text-[32px]"
        data-testid="profile-handle"
      >
        {profile.user.handle ? `@${profile.user.handle}` : t("anonymous")}
      </h1>
      <p className="mt-3 font-mono text-[11.5px] uppercase tracking-[0.03em] text-meta">
        {t("memberSince", { date: dateFormat.format(profile.user.createdAt) })}
      </p>

      {notifications && <NotificationPanel summary={notifications} />}

      {isSelf && (
        <div
          className="mt-6 border border-line bg-surface px-4 py-3.5"
          data-testid="profile-own-hint"
        >
          <p className="font-serif text-[15px] leading-relaxed">
            {t("ownProfile")}
          </p>
          {openChangeRequests.total > 0 && (
            <div className="mt-2" data-testid="profile-open-change-requests">
              <p className="font-mono text-xs text-ink">
                {t("openChangeRequests", { count: openChangeRequests.total })}
              </p>
              {/* Mit Link zum Ticket — ohne ihn müsste der Autor es suchen. */}
              <ul className="mt-1 flex flex-col gap-0.5">
                {openChangeRequests.tickets.map((entry) => (
                  <li key={entry.ticketId}>
                    <Link
                      href={`/tickets/${entry.ticketId}`}
                      data-testid="profile-open-change-request-link"
                      className="font-serif text-[14.5px] underline underline-offset-4 hover:text-ink"
                    >
                      {entry.title}
                    </Link>
                    {entry.count > 1 && (
                      <span className="ml-1.5 font-mono text-[11.5px] text-meta">
                        {t("openChangeRequestsOnTicket", {
                          count: entry.count,
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Link
            href="/einstellungen"
            data-testid="profile-settings-link"
            className="mt-2 inline-block font-mono text-xs text-meta underline underline-offset-2 hover:text-ink"
          >
            {t("settingsLink")}
          </Link>
        </div>
      )}

      <section className="mt-10" data-testid="profile-tickets">
        <h2 className={SECTION_HEADING}>
          {t("ticketsHeading", { count: profile.tickets.length })}
        </h2>
        {ticketRows(profile.tickets, t("emptyTickets"))}
      </section>

      <section className="mt-8" data-testid="profile-coauthored">
        <h2 className={SECTION_HEADING}>
          {t("coAuthorHeading", { count: profile.coAuthoredTickets.length })}
        </h2>
        {ticketRows(profile.coAuthoredTickets, t("emptyCoAuthor"))}
      </section>

      <section className="mt-8" data-testid="profile-statements">
        <h2 className={SECTION_HEADING}>
          {t("statementsHeading", { count: profile.statements.length })}
        </h2>
        {statementRows(profile.statements)}
      </section>

      {/* Transparenz: Abstimmungen öffentlich, Zustimmung und Ablehnung
          bewusst GETRENNT (nie als Netto-Score). */}
      <section className="mt-8" data-testid="profile-votes">
        <h2 className={SECTION_HEADING}>{t("votesHeading")}</h2>
        <p className="mb-4 font-mono text-xs text-meta">
          {t("transparencyNote")}
        </p>
        <div className="grid gap-6 sm:grid-cols-2">
          <div data-testid="profile-votes-up">
            <h3 className={SECTION_HEADING}>
              {t("approvals", { count: profile.upvotedTickets.length })}
            </h3>
            {voteRows(profile.upvotedTickets)}
          </div>
          <div data-testid="profile-votes-down">
            <h3 className={SECTION_HEADING}>
              {t("rejections", { count: profile.downvotedTickets.length })}
            </h3>
            {voteRows(profile.downvotedTickets)}
          </div>
        </div>
      </section>
    </div>
  );
}
