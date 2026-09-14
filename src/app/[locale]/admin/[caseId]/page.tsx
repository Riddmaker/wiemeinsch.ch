import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { CaseActions } from "@/components/moderation/CaseActions";
import { RichTextView } from "@/components/tickets/RichTextView";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { getDisplayLocale } from "@/lib/display-locale";
import { loadModerationCase } from "@/lib/moderation";
import { reasonLabels } from "@/lib/moderation-labels";
import { adminUserId } from "@/lib/require-admin";

/**
 * Detailansicht eines Moderationsfalls (P12.3): betroffener Inhalt bzw.
 * angefochtener Entwurf, die Linter-Begründungen und die drei Entscheide.
 * LLM-Text (Linter-Begründung) wird ausschliesslich als Text gerendert, nie
 * als HTML (OWASP Insecure Output Handling).
 */

const RICH_TEXT_CLASSES =
  "max-w-[66ch] font-serif text-[15px] leading-[1.7] " +
  "[&_p]:mb-2.5 [&_ul]:mb-2.5 [&_ul]:list-disc [&_ul]:pl-6";

const SECTION_HEADING =
  "mb-2 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta";

export default async function AdminCasePage({
  params,
}: PageProps<"/[locale]/admin/[caseId]">) {
  const { locale, caseId } = await params;
  const adminId = await adminUserId();
  if (!adminId) {
    notFound();
  }

  const { displayLocale } = await getDisplayLocale(locale as AppLocale);
  const moderationCase = await loadModerationCase(caseId, displayLocale);
  if (!moderationCase) {
    notFound();
  }

  const t = await getTranslations("admin");
  const tLinter = await getTranslations("linter");

  const dateFormat = new Intl.DateTimeFormat(`${locale}-CH`, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const reasons = await reasonLabels(
    moderationCase.type,
    moderationCase.reason,
  );

  const target = moderationCase.target;
  const isOpen = moderationCase.status === "OPEN";
  const canDepublish =
    isOpen &&
    moderationCase.type === "REPORT" &&
    (target?.kind === "ticket" || target?.kind === "statement") &&
    target.status === "PUBLISHED";
  const canApprove =
    isOpen && moderationCase.type === "APPEAL" && target?.kind === "draft";

  return (
    <article
      data-testid="admin-case"
      data-case-type={moderationCase.type}
      className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14"
    >
      <Link
        href="/admin"
        className="font-mono text-xs text-meta underline underline-offset-2 hover:text-ink"
      >
        {t("back")}
      </Link>

      <h1 className="mt-4 font-serif text-[26px] font-bold leading-[1.3] sm:text-[30px]">
        {t("caseHeading", {
          type: t(`case${moderationCase.type}`),
          date: dateFormat.format(moderationCase.createdAt),
        })}
      </h1>

      <p className="mt-3 font-mono text-[11.5px] uppercase tracking-[0.03em] text-meta">
        {moderationCase.type === "REPORT"
          ? t("reportedBy", { handle: moderationCase.reporterHandle ?? "?" })
          : t("appealedBy", { handle: moderationCase.reporterHandle ?? "?" })}
      </p>

      <section className="mt-6">
        <h2 className={SECTION_HEADING}>{t("reasonHeading")}</h2>
        <p data-testid="case-reason" className="font-mono text-[13px]">
          {reasons.join(" · ")}
        </p>
      </section>

      {!isOpen && (
        <p
          data-testid="case-resolution"
          className="mt-6 border border-line bg-surface px-4 py-3 font-mono text-xs text-meta"
        >
          {t("resolvedInfo", {
            decision: moderationCase.decision
              ? t(`decisions.${moderationCase.decision}`)
              : "—",
            date: dateFormat.format(
              moderationCase.resolvedAt ?? moderationCase.createdAt,
            ),
          })}
          {moderationCase.note &&
            ` · ${t("noteInfo", { note: moderationCase.note })}`}
        </p>
      )}

      <section className="mt-8">
        <h2 className={SECTION_HEADING}>
          {target?.kind === "draft" ? t("draftHeading") : t("contentHeading")}
        </h2>

        {!target && (
          <p
            data-testid="case-content-gone"
            className="font-mono text-xs text-meta"
          >
            {t("contentGone")}
          </p>
        )}

        {target?.kind === "ticket" && (
          <div data-testid="case-content">
            {target.status === "DEPUBLISHED" && (
              <p className="mb-3 font-mono text-xs uppercase tracking-wide text-signal">
                {t("contentDepublished")}
              </p>
            )}
            <h3 className="font-serif text-xl font-bold">{target.title}</h3>
            <h4 className="mt-4 font-mono text-[11.5px] uppercase tracking-wide text-meta">
              {t("fields.problem")}
            </h4>
            <RichTextView doc={target.problem} className={RICH_TEXT_CLASSES} />
            <h4 className="mt-4 font-mono text-[11.5px] uppercase tracking-wide text-meta">
              {t("fields.solution")}
            </h4>
            <RichTextView doc={target.solution} className={RICH_TEXT_CLASSES} />
            {target.funding !== null && (
              <>
                <h4 className="mt-4 font-mono text-[11.5px] uppercase tracking-wide text-meta">
                  {t("fields.funding")}
                </h4>
                <RichTextView
                  doc={target.funding}
                  className={RICH_TEXT_CLASSES}
                />
              </>
            )}
            <Link
              href={`/tickets/${target.id}`}
              className="mt-4 inline-block font-mono text-xs underline underline-offset-2 hover:text-ink"
            >
              {t("viewContent")}
            </Link>
          </div>
        )}

        {target?.kind === "statement" && (
          <div data-testid="case-content">
            {target.status === "DEPUBLISHED" && (
              <p className="mb-3 font-mono text-xs uppercase tracking-wide text-signal">
                {t("contentDepublished")}
              </p>
            )}
            <RichTextView doc={target.doc} className={RICH_TEXT_CLASSES} />
            <Link
              href={`/tickets/${target.ticketId}`}
              className="mt-4 inline-block font-mono text-xs underline underline-offset-2 hover:text-ink"
            >
              {t("viewContent")}
            </Link>
          </div>
        )}

        {target?.kind === "draft" && (
          <div data-testid="case-draft">
            {target.title && (
              <h3 className="font-serif text-xl font-bold">{target.title}</h3>
            )}
            {target.hashtags.length > 0 && (
              <p className="mt-2 font-mono text-[12.5px] text-meta">
                {target.hashtags.map((tag) => `#${tag}`).join(" ")}
              </p>
            )}
            {target.docs.map((entry) => (
              <div key={entry.label}>
                <h4 className="mt-4 font-mono text-[11.5px] uppercase tracking-wide text-meta">
                  {t(`fields.${entry.label}`)}
                </h4>
                <RichTextView doc={entry.doc} className={RICH_TEXT_CLASSES} />
              </div>
            ))}
            {/* Nach der Freigabe zeigt der Fall auf den publizierten Inhalt —
                sonst wüsste niemand, was aus dem Entwurf geworden ist. */}
            {!isOpen && moderationCase.ticketId && (
              <Link
                href={`/tickets/${moderationCase.ticketId}`}
                data-testid="case-published-link"
                className="mt-4 inline-block font-mono text-xs underline underline-offset-2 hover:text-ink"
              >
                {t("viewContent")}
              </Link>
            )}
          </div>
        )}
      </section>

      {target?.kind === "draft" && target.findings.length > 0 && (
        <section className="mt-8">
          <h2 className={SECTION_HEADING}>{t("findingsHeading")}</h2>
          {/*
            OWASP GenAI (LLM01, zweiter Ordnung): Die Begründungen stammen
            aus einem LLM, das den beanstandeten Text gelesen hat. Ein
            Einreichender kann versuchen, über seinen Text die Formulierung
            der Begründung zu steuern und so den Admin zu beeinflussen. Der
            Hinweis macht die Herkunft explizit — gerendert wird ohnehin nur
            Text (P13.4).
          */}
          <p className="mb-3 font-mono text-xs leading-relaxed text-meta">
            {t("findingsNote")}
          </p>
          <ul data-testid="case-findings" className="flex flex-col gap-2">
            {target.findings.map((finding, index) => (
              <li
                key={index}
                className="border border-line border-t-2 border-t-signal bg-signal-bg px-4 py-2.5 font-mono text-xs"
              >
                <span className="font-bold uppercase tracking-wide text-signal">
                  {t(`fields.${finding.field}`)} ·{" "}
                  {tLinter.has(`reasons.${finding.reason}`)
                    ? tLinter(`reasons.${finding.reason}`)
                    : finding.reason}
                </span>
                {finding.explanation && (
                  <span className="mt-1 block text-ink">
                    {finding.explanation}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {isOpen && (
        <CaseActions
          caseId={moderationCase.id}
          canDepublish={canDepublish}
          canApprove={canApprove}
        />
      )}
    </article>
  );
}
