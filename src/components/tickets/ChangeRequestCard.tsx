import { getTranslations } from "next-intl/server";
import { ChangeRequestDecision } from "@/components/tickets/ChangeRequestDecision";
import { DiffView } from "@/components/tickets/DiffView";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import type {
  ChangeRequestEntry,
  ChangeRequestStatus,
} from "@/lib/change-requests";
import { diffTags } from "@/lib/text-diff";
import type { ChangeRequestTextField } from "@/lib/validation/change-request";
import { plainText, type ConstrainedDoc } from "@/lib/validation/tiptap";

/**
 * Ein Änderungsantrag (P10.2). Farbe bleibt sonst den Statements vorbehalten
 * (Styleguide Art. 5), der Status ist deshalb schwarz-weiss ausgezeichnet.
 *
 * E13 (04.09.2026), aus dem User-Test:
 * - **Eingeklappt per Default.** Aufgeklappte Anträge füllten die Seite, das
 *   Statement-Dashboard darunter war nicht mehr sichtbar — genau die
 *   Mitmach-Sektion verschwand hinter der Verwaltung. `<details>` statt
 *   JavaScript: funktioniert ohne Skript und ist tastaturbedienbar.
 * - **Diff statt Gegenüberstellung.** Vorher standen alt und neu als zwei
 *   Blöcke nebeneinander; wer den Unterschied wollte, musste ihn selbst
 *   suchen. Jetzt zeigt ein Block, was weg- und was dazukommt.
 */

const STATUS_CHIP: Record<ChangeRequestStatus, string> = {
  OPEN: "border-ink text-ink",
  MERGED: "border-ink bg-ink text-paper",
  DECLINED: "border-line text-meta",
};

export type CurrentTicketVersion = {
  title: string;
  problem: unknown;
  solution: unknown;
  funding: unknown;
  hashtags: string[];
};

/** Reiner Text eines Feldes; fehlende Felder sind leer, nicht «undefined». */
function textOf(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return plainText(value as ConstrainedDoc);
  } catch {
    return "";
  }
}

export async function ChangeRequestCard({
  entry,
  current,
  locale,
  isTicketAuthor,
}: {
  entry: ChangeRequestEntry;
  /** Aktuelle Ticket-Fassung in der Lese-Sprache — die «alte» Seite. */
  current: CurrentTicketVersion;
  /** Locale der Route — Datumsformat. */
  locale: AppLocale;
  isTicketAuthor: boolean;
}) {
  const t = await getTranslations("changeRequests");
  const tTicket = await getTranslations("ticketDetail");
  const tNew = await getTranslations("ticketNew");
  const tRoot = await getTranslations();

  const dateFormat = new Intl.DateTimeFormat(`${locale}-CH`, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const fieldLabel: Record<ChangeRequestTextField, string> = {
    title: tNew("titleLabel"),
    problem: tTicket("problem"),
    solution: tTicket("solution"),
    funding: tTicket("funding"),
  };

  // Was der Antrag anfasst — als Fliesstext in der Zusammenfassung, damit man
  // es auch im eingeklappten Zustand sieht.
  const changedLabels = [
    ...entry.changedFields.map((field) => fieldLabel[field]),
    ...(entry.hashtags ? [t("hashtagsField")] : []),
  ].join(", ");

  const tagDiff = entry.hashtags
    ? diffTags(current.hashtags, entry.hashtags)
    : [];

  return (
    <details
      data-testid="change-request-card"
      data-status={entry.status}
      // Das Dreieck dreht sich beim Aufklappen mit — der Zustand muss auch
      // ohne JavaScript sichtbar sein, deshalb über den `open`-Zustand des
      // `<details>` statt über React-State.
      className="border border-line bg-paper [&[open]>summary]:border-b [&[open]>summary]:border-line [&[open]_[data-marker]]:rotate-90"
    >
      <summary className="cursor-pointer list-none p-4 marker:content-none sm:p-5 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-[11.5px] uppercase tracking-[0.03em] text-meta">
          <span
            aria-hidden="true"
            data-marker
            className="inline-block font-bold text-ink transition-transform motion-reduce:transition-none"
          >
            ▸
          </span>
          <span
            data-testid="change-request-number"
            className="font-bold text-ink"
          >
            {t("number", { number: entry.number })}
          </span>
          <span
            data-testid="change-request-status"
            className={`inline-block rounded-[2px] border px-2 py-0.5 font-bold ${STATUS_CHIP[entry.status]}`}
          >
            {t(`status.${entry.status}`)}
          </span>
          {entry.authorHandle && (
            <span>{t("by", { handle: entry.authorHandle })}</span>
          )}
          <span>
            {t("submitted", { date: dateFormat.format(entry.createdAt) })}
          </span>
          {entry.decidedAt && (
            <span>
              {t("decided", { date: dateFormat.format(entry.decidedAt) })}
            </span>
          )}
        </div>
        <p
          data-testid="change-request-fields"
          className="mt-1.5 font-mono text-[11.5px] text-meta"
        >
          {t("changes", { fields: changedLabels })}
        </p>
      </summary>

      <div className="p-4 sm:p-5">
        <p className="font-mono text-[11.5px] uppercase tracking-[0.03em] text-meta">
          {entry.authorHandle && (
            <>
              <Link
                href={`/profil/${entry.authorId}`}
                className="underline underline-offset-2 hover:text-ink"
              >
                {t("by", { handle: entry.authorHandle })}
              </Link>
              {" · "}
            </>
          )}
          {t("original", {
            language: tRoot(`localeSwitcher.${entry.originalLocale}`),
          })}
          {entry.isTranslated && ` · ${t("aiTranslated")}`}
        </p>

        <p className="mt-3 font-mono text-[11px] uppercase tracking-wide text-meta">
          {t("diffLegend")}
        </p>

        {entry.changedFields.map((field) => (
          <section key={field} className="mt-5">
            <h3 className="mb-1.5 font-mono text-[12px] font-bold uppercase tracking-wide text-ink">
              {fieldLabel[field]}
            </h3>
            <DiffView
              testId={`change-request-diff-${field}`}
              before={textOf(current[field])}
              after={textOf(entry.display[field])}
            />
          </section>
        ))}

        {entry.hashtags && (
          <section className="mt-5">
            <h3 className="mb-1.5 font-mono text-[12px] font-bold uppercase tracking-wide text-ink">
              {t("hashtagsField")}
            </h3>
            <div
              data-testid="change-request-diff-hashtags"
              className="flex flex-wrap gap-1.5 font-mono text-[13px]"
            >
              {tagDiff.map(({ tag, type }) => {
                if (type === "removed") {
                  return (
                    <del
                      key={`del-${tag}`}
                      className="border border-line px-1.5 py-0.5 text-contra"
                    >
                      #{tag}
                    </del>
                  );
                }
                if (type === "added") {
                  return (
                    <ins
                      key={`ins-${tag}`}
                      className="border border-line px-1.5 py-0.5 text-pro no-underline"
                    >
                      #{tag}
                    </ins>
                  );
                }
                return (
                  <span
                    key={`same-${tag}`}
                    className="border border-line px-1.5 py-0.5 text-meta"
                  >
                    #{tag}
                  </span>
                );
              })}
            </div>
          </section>
        )}

        {isTicketAuthor && entry.status === "OPEN" && entry.versions && (
          <ChangeRequestDecision
            changeRequestId={entry.id}
            proposedVersions={entry.versions}
            changedFields={entry.changedFields}
            {...(entry.hashtags ? { proposedHashtags: entry.hashtags } : {})}
            isStale={entry.isStale}
          />
        )}
      </div>
    </details>
  );
}
