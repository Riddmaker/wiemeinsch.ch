import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { getDisplayLocale } from "@/lib/display-locale";
import {
  countOpenCases,
  loadModerationQueue,
  type CaseSummary,
} from "@/lib/moderation";
import { reasonLabels } from "@/lib/moderation-labels";
import { adminUserId } from "@/lib/require-admin";
import { queueFilterSchema } from "@/lib/validation/moderation";

/**
 * Moderations-Queue (P12.3). Der Zugang wird serverseitig über
 * `adminUserId()` geprüft; ohne Recht gibt es 404 statt 403 — die Existenz
 * des Bereichs wird nicht bestätigt, und es wird nichts geladen, bevor das
 * Recht feststeht (keine Queue-Daten im Response).
 */

const STATUS_FILTERS = ["OPEN", "RESOLVED"] as const;
const TYPE_FILTERS = ["ALL", "REPORT", "APPEAL"] as const;

export default async function AdminQueuePage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin">) {
  const { locale } = await params;
  const adminId = await adminUserId();
  if (!adminId) {
    notFound();
  }

  const sp = await searchParams;
  const filter = queueFilterSchema.parse({ status: sp.status, type: sp.type });
  const { displayLocale } = await getDisplayLocale(locale as AppLocale);
  const t = await getTranslations("admin");

  const [cases, openCount] = await Promise.all([
    loadModerationQueue(filter, displayLocale),
    countOpenCases(),
  ]);
  // Grund-Codes werden über denselben Helfer übersetzt wie im Fall-Detail.
  const reasons = await Promise.all(
    cases.map((entry) => reasonLabels(entry.type, entry.reason)),
  );

  const dateFormat = new Intl.DateTimeFormat(`${locale}-CH`, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const filterLink = (patch: { status?: string; type?: string }) => ({
    pathname: "/admin" as const,
    query: {
      status: patch.status ?? filter.status,
      type: patch.type ?? filter.type,
    },
  });

  return (
    <div
      data-testid="admin-queue"
      className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14"
    >
      <h1 className="font-serif text-3xl font-bold leading-tight sm:text-4xl">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-[60ch] font-serif text-lg leading-relaxed text-ink">
        {t("intro")}
      </p>
      <p
        data-testid="admin-open-count"
        className="mt-3 font-mono text-xs uppercase tracking-wide text-meta"
      >
        {t("openCases", { count: openCount })}
      </p>

      <nav
        aria-label={t("filterStatus")}
        className="mt-8 flex flex-wrap gap-1 border-b-2 border-ink"
      >
        {STATUS_FILTERS.map((value) => (
          <Link
            key={value}
            data-testid={`admin-filter-${value.toLowerCase()}`}
            href={filterLink({ status: value })}
            aria-current={value === filter.status ? "page" : undefined}
            className={`px-4 pb-[9px] pt-2.5 font-mono text-[12.5px] font-bold uppercase tracking-[0.06em] ${
              value === filter.status
                ? "bg-ink text-paper"
                : "text-meta hover:text-ink"
            }`}
          >
            {t(`status${value}`)}
          </Link>
        ))}
      </nav>

      <div
        role="group"
        aria-label={t("filterType")}
        className="mt-4 flex flex-wrap gap-2"
      >
        {TYPE_FILTERS.map((value) => (
          <Link
            key={value}
            data-testid={`admin-type-${value.toLowerCase()}`}
            href={filterLink({ type: value })}
            aria-current={value === filter.type ? "true" : undefined}
            className={`rounded-[2px] border px-3 py-1 font-mono text-[11.5px] uppercase tracking-wide ${
              value === filter.type
                ? "border-ink text-ink"
                : "border-line text-meta hover:border-ink hover:text-ink"
            }`}
          >
            {t(`type${value}`)}
          </Link>
        ))}
      </div>

      {cases.length === 0 ? (
        <p
          data-testid="admin-empty"
          className="mt-6 border border-line bg-surface px-4 py-3 font-mono text-xs text-meta"
        >
          {t("empty")}
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {cases.map((entry, index) => (
            <li key={entry.id}>
              <CaseRow
                entry={entry}
                date={dateFormat.format(entry.createdAt)}
                typeLabel={t(`case${entry.type}`)}
                reasonLabel={t("columnReason")}
                reasons={reasons[index] ?? []}
                openLabel={t("open")}
                byLabel={
                  entry.type === "REPORT"
                    ? t("reportedBy", { handle: entry.reporterHandle ?? "?" })
                    : t("appealedBy", { handle: entry.reporterHandle ?? "?" })
                }
                decisionLabel={
                  entry.decision ? t(`decisions.${entry.decision}`) : null
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseRow({
  entry,
  date,
  typeLabel,
  reasonLabel,
  reasons,
  openLabel,
  byLabel,
  decisionLabel,
}: {
  entry: CaseSummary;
  date: string;
  typeLabel: string;
  reasonLabel: string;
  reasons: string[];
  openLabel: string;
  byLabel: string;
  decisionLabel: string | null;
}) {
  return (
    <article
      data-testid="admin-case-row"
      data-case-type={entry.type}
      className="border border-line bg-paper px-[18px] py-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-block rounded-[2px] border border-current px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.07em] text-meta">
          {typeLabel}
        </span>
        <span className="font-mono text-[11.5px] text-meta">
          {byLabel} · {date}
        </span>
        {decisionLabel && (
          <span className="font-mono text-[11.5px] font-bold uppercase tracking-wide text-meta">
            {decisionLabel}
          </span>
        )}
      </div>

      <p className="mt-2 font-serif text-[15px] leading-[1.5]">
        {entry.headline}
      </p>

      <p className="mt-1.5 font-mono text-[11.5px] uppercase tracking-wide text-meta">
        {reasonLabel}: {reasons.join(" · ")}
      </p>

      <Link
        href={`/admin/${entry.id}`}
        data-testid="admin-case-link"
        className="mt-2.5 inline-block font-mono text-xs underline underline-offset-2 hover:text-ink"
      >
        {openLabel}
      </Link>
    </article>
  );
}
