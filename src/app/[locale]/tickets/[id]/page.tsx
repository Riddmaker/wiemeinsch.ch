import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ReportButton } from "@/components/moderation/ReportButton";
import { StatementForm } from "@/components/statements/StatementForm";
import { StatementList } from "@/components/statements/StatementList";
import { ChangeRequestSection } from "@/components/tickets/ChangeRequestSection";
import { RichTextView } from "@/components/tickets/RichTextView";
import { VoteButtons } from "@/components/tickets/VoteButtons";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { loadChangeRequests } from "@/lib/change-requests";
import { getDisplayLocale } from "@/lib/display-locale";
import { toAppLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { regionName } from "@/lib/ticket-display";
import { pickTranslation } from "@/lib/translations";

/**
 * Ticket-Detailseite (P7.6): Republik-Style-Rendering (font-serif) mit
 * Meta-Zeile (mono) — Originalsprache, AI-Übersetzungs-Hinweis und Toggle
 * «Im Original anzeigen» (?original=1, serverseitig gerendert).
 * Eingeloggte sehen ihre bevorzugte Sprache, ausgeloggte die Routen-Locale.
 */

const RICH_TEXT_CLASSES =
  "max-w-[66ch] font-serif text-[16px] leading-[1.75] " +
  "[&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6";

export default async function TicketDetailPage({
  params,
  searchParams,
}: PageProps<"/[locale]/tickets/[id]">) {
  const { locale, id } = await params;
  const sp = await searchParams;
  const showOriginal = sp.original === "1";
  const t = await getTranslations("ticketDetail");
  const tStatements = await getTranslations("statements");
  const tRoot = await getTranslations();

  const { displayLocale, userId } = await getDisplayLocale(locale as AppLocale);

  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: {
      translations: true,
      hashtags: { orderBy: { tag: "asc" } },
      canton: true,
      municipality: true,
      author: { select: { handle: true } },
    },
  });
  if (!ticket || ticket.status !== "PUBLISHED") {
    notFound();
  }

  const originalLocale = toAppLocale(ticket.originalLocale);
  const effectiveLocale = showOriginal ? originalLocale : displayLocale;
  const version = pickTranslation(ticket.translations, effectiveLocale);
  if (!version) {
    notFound();
  }

  // Änderungsanträge (P10) folgen immer der Lese-Sprache, nie dem
  // ?original=1-Toggle: Vergleich und Formular sollen in einer Sprache stehen.
  const readingVersion =
    pickTranslation(ticket.translations, displayLocale) ?? version;
  const isTicketAuthor = userId === ticket.authorId;
  const changeRequests = await loadChangeRequests({
    ticketId: ticket.id,
    solutionRevision: ticket.solutionRevision,
    displayLocale,
    includeVersions: isTicketAuthor,
  });
  const coAuthorships = changeRequests.filter(
    (entry) => entry.status === "MERGED" && entry.authorHandle,
  );

  const region = regionName(ticket, locale as AppLocale);
  const levelChip = region
    ? `${tRoot(`levels.${ticket.level}`)} · ${region}`
    : tRoot(`levels.${ticket.level}`);

  const myVote = userId
    ? ((
        await prisma.ticketVote.findUnique({
          where: { userId_ticketId: { userId, ticketId: ticket.id } },
          select: { value: true },
        })
      )?.value ?? null)
    : null;

  const dateFormat = new Intl.DateTimeFormat(`${locale}-CH`, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const isTranslated = !version.isOriginal;
  const canToggleToOriginal = isTranslated;
  const canToggleBack = showOriginal && displayLocale !== originalLocale;

  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-block rounded-[2px] border border-current px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-meta">
          {levelChip}
        </span>
      </div>

      <h1 className="mt-4 font-serif text-[28px] font-bold leading-[1.3] sm:text-[32px]">
        {version.title}
      </h1>

      {/* Meta-Zeile (Styleguide Art. 6 — Übersetzungs-Hinweis) */}
      <div className="mt-4 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-[11.5px] uppercase tracking-[0.03em] text-meta">
        <span>
          {t("created", { date: dateFormat.format(ticket.createdAt) })}
        </span>
        {ticket.author.handle && (
          <Link
            href={`/profil/${ticket.authorId}`}
            className="underline underline-offset-2 hover:text-ink"
          >
            {t("by", { handle: ticket.author.handle })}
          </Link>
        )}
        <span>
          {t("original", {
            language: tRoot(`localeSwitcher.${originalLocale}`),
          })}
          {isTranslated && ` · ${t("aiTranslated")}`}
        </span>
        {canToggleToOriginal && (
          <Link
            href={{
              pathname: `/tickets/${ticket.id}`,
              query: { original: "1" },
            }}
            className="underline underline-offset-2 hover:text-ink"
          >
            {t("showOriginal")}
          </Link>
        )}
        {canToggleBack && (
          <Link
            href={`/tickets/${ticket.id}`}
            className="underline underline-offset-2 hover:text-ink"
          >
            {t("showTranslation")}
          </Link>
        )}
        {/* Co-Autorschaft nach gemergtem Änderungsantrag (Styleguide Art. 6). */}
        {coAuthorships.map((entry) => (
          <Link
            key={entry.id}
            href={`/profil/${entry.authorId}`}
            data-testid="co-author"
            className="underline underline-offset-2 hover:text-ink"
          >
            {t("coAuthor", {
              handle: entry.authorHandle ?? "",
              number: entry.number,
              date: dateFormat.format(entry.decidedAt ?? entry.createdAt),
            })}
          </Link>
        ))}
        {/* Melden (P12.1) — stiller Link in der Meta-Zeile, kein Warn-Element. */}
        <ReportButton
          target={{ kind: "ticket", id: ticket.id }}
          isLoggedIn={userId !== null}
        />
      </div>

      {ticket.hashtags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {ticket.hashtags.map((hashtag) => (
            <span
              key={hashtag.id}
              className="font-mono text-[12.5px] text-meta"
            >
              #{hashtag.tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-6">
        <VoteButtons
          target={{ kind: "ticket", id: ticket.id }}
          initialUpvotes={ticket.upvotes}
          initialDownvotes={ticket.downvotes}
          initialMyVote={myVote}
          isLoggedIn={userId !== null}
        />
      </div>

      <section className="mt-10">
        <h2 className="mb-3 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta">
          {t("problem")}
        </h2>
        <RichTextView doc={version.problem} className={RICH_TEXT_CLASSES} />
      </section>

      <section className="mt-8" data-testid="ticket-solution">
        <h2 className="mb-3 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta">
          {t("solution")}
        </h2>
        <RichTextView doc={version.solution} className={RICH_TEXT_CLASSES} />
      </section>

      {version.funding !== null && (
        <section className="mt-8">
          <h2 className="mb-3 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta">
            {t("funding")}
          </h2>
          <RichTextView doc={version.funding} className={RICH_TEXT_CLASSES} />
        </section>
      )}

      {/* Political Pull Request (P10): Anträge auf den Lösungstext. */}
      <ChangeRequestSection
        ticketId={ticket.id}
        entries={changeRequests}
        currentSolution={readingVersion.solution}
        contentLocale={displayLocale}
        routeLocale={locale as AppLocale}
        isAuthor={isTicketAuthor}
        viewerId={userId}
      />

      {/* Statement-Dashboard (P9): Formular über der Liste — keine Antworten. */}
      <section className="mt-12">
        <h2 className="mb-1 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta">
          {tStatements("formHeading")}
        </h2>
        <StatementForm ticketId={ticket.id} isLoggedIn={userId !== null} />
      </section>

      {/* Statements folgen der Lese-Sprache, nicht dem Original-Toggle des
          Tickets — sie sind eigenständige Inhalte mit eigenem Original. */}
      <StatementList
        ticketId={ticket.id}
        displayLocale={displayLocale}
        routeLocale={locale as AppLocale}
        userId={userId}
      />
    </article>
  );
}
