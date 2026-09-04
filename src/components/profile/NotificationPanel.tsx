import { getTranslations } from "next-intl/server";
import { MarkNotificationsReadButton } from "@/components/profile/MarkNotificationsReadButton";
import { Link } from "@/i18n/navigation";
import type { NotificationSummary } from "@/lib/notifications";

/**
 * Benachrichtigungen auf der EIGENEN Profilseite (E14, 04.09.2026).
 *
 * `/profil/[id]` ist eine öffentliche Route — dieses Panel wird deshalb nur
 * gerendert, wenn der Betrachter der Profilinhaber ist. Die Prüfung liegt in
 * der Seite (`isSelf`), und ein Test hält fest, dass Fremde es nie sehen.
 *
 * Gezeigt werden die aktuellen GESAMTZAHLEN, nicht Deltas — das ist der
 * bewusste Handel für «keine Ereignistabelle» (siehe lib/notifications.ts).
 * Die Überschrift sagt das auch so, statt eine Zahl als «neu» auszugeben.
 */
export async function NotificationPanel({
  summary,
}: {
  summary: NotificationSummary;
}) {
  const t = await getTranslations("notifications");
  const tStatements = await getTranslations("statements.categories");

  const hasAnything =
    summary.reactions !== null ||
    summary.statements !== null ||
    summary.changeRequests !== null;
  if (!hasAnything) {
    return null;
  }

  const rows: { key: string; label: string; value: string }[] = [];

  if (summary.reactions) {
    rows.push({
      key: "reactions",
      label: t("reactions"),
      value: t("reactionCounts", {
        up: summary.reactions.up,
        down: summary.reactions.down,
      }),
    });
  }

  if (summary.statements) {
    const parts = (["PRO", "CONTRA", "ERWEITERUNG", "FRAGE"] as const)
      .filter((category) => summary.statements![category] > 0)
      .map(
        (category) =>
          `${String(summary.statements![category])} ${tStatements(category)}`,
      );
    rows.push({
      key: "statements",
      label: t("statements"),
      value: parts.join(" · "),
    });
  }

  if (summary.changeRequests !== null) {
    rows.push({
      key: "changeRequests",
      label: t("changeRequests"),
      value: t("changeRequestCount", { count: summary.changeRequests }),
    });
  }

  return (
    <section
      data-testid="notification-panel"
      className="mt-6 border-[1.5px] border-ink bg-paper px-4 py-4 sm:px-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="font-mono text-xs font-bold uppercase tracking-wide text-ink">
          {t("heading")}
        </h2>
        <MarkNotificationsReadButton label={t("markRead")} />
      </div>

      <p className="mt-1.5 font-mono text-[11.5px] text-meta">{t("intro")}</p>

      <dl className="mt-4 flex flex-col gap-2.5">
        {rows.map((row) => (
          <div
            key={row.key}
            data-testid={`notification-${row.key}`}
            className="flex flex-wrap gap-x-3 gap-y-0.5"
          >
            <dt className="min-w-[9rem] font-mono text-[11.5px] uppercase tracking-wide text-meta">
              {row.label}
            </dt>
            <dd className="font-mono text-[13px] font-bold text-ink">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {summary.tickets.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="font-mono text-[11.5px] uppercase tracking-wide text-meta">
            {t("affected")}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {summary.tickets.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  href={`/tickets/${ticket.id}`}
                  data-testid="notification-ticket-link"
                  className="font-serif text-[15px] underline underline-offset-4 hover:text-ink"
                >
                  {ticket.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
