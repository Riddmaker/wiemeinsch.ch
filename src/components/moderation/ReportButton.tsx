"use client";

import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { reportContent } from "@/actions/moderation";
import { LoginHint } from "@/components/auth/LoginHint";
import { REPORT_REASONS, type ReportReason } from "@/lib/validation/moderation";

/**
 * Melde-Funktion (P12.1): stiller Text-Link
 * in der Meta-Zeile, kein farbiges Warn-Element — ein gemeldeter Beitrag wird
 * NICHT öffentlich markiert (Anti-Pranger, Manifest). Fester Grund-Katalog,
 * kein Freitext (User-Entscheid 30.08.2026).
 */
export function ReportButton({
  target,
  isLoggedIn,
}: {
  target: { kind: "ticket" | "statement"; id: string };
  isLoggedIn: boolean;
}) {
  const t = useTranslations("moderation");
  const groupId = useId();
  const [open, setOpen] = useState(false);
  const [showLoginHint, setShowLoginHint] = useState(false);
  const [reason, setReason] = useState<ReportReason>(REPORT_REASONS[0]);
  const [status, setStatus] = useState<"idle" | "sent">("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const testId = `report-${target.kind}`;

  if (status === "sent") {
    return (
      <span
        data-testid={`${testId}-sent`}
        role="status"
        className="font-mono text-[11.5px] text-meta"
      >
        {t("sent")}
      </span>
    );
  }

  const submit = () => {
    setErrorCode(null);
    startTransition(async () => {
      const result = await reportContent({
        targetType: target.kind === "ticket" ? "TICKET" : "STATEMENT",
        targetId: target.id,
        reason,
      });
      if (result.ok) {
        setOpen(false);
        setStatus("sent");
        return;
      }
      setErrorCode(result.error);
    });
  };

  return (
    <span className="font-mono text-[11.5px] text-meta">
      <button
        type="button"
        data-testid={testId}
        onClick={() => {
          if (!isLoggedIn) {
            setShowLoginHint(true);
            return;
          }
          setOpen((value) => !value);
        }}
        className="underline underline-offset-2 hover:text-ink"
      >
        {t("report")}
      </button>

      {showLoginHint && !isLoggedIn && (
        <LoginHint
          message={t("loginHint")}
          linkLabel={t("loginLink")}
          testId={`${testId}-login`}
        />
      )}

      {open && isLoggedIn && (
        <div
          data-testid={`${testId}-dialog`}
          className="mt-2.5 max-w-[420px] border border-line bg-surface px-4 py-3.5 normal-case"
        >
          <p className="font-mono text-xs font-bold uppercase tracking-wide text-ink">
            {t("dialogTitle")}
          </p>
          <p className="mt-1.5 font-sans text-[13px] leading-[1.5] text-meta">
            {t("dialogIntro")}
          </p>

          <fieldset className="mt-3 flex flex-col gap-1.5">
            <legend className="sr-only">{t("reasonLegend")}</legend>
            {REPORT_REASONS.map((value) => (
              <label
                key={value}
                className="flex items-center gap-2 font-sans text-[13px] text-ink"
              >
                <input
                  type="radio"
                  name={groupId}
                  value={value}
                  checked={reason === value}
                  onChange={() => setReason(value)}
                  className="h-3.5 w-3.5 accent-ink"
                />
                {t(`reasons.${value}`)}
              </label>
            ))}
          </fieldset>

          {errorCode && (
            <p role="alert" className="mt-2.5 font-mono text-xs text-signal">
              {errorCode === "unauthorized" ||
              errorCode === "rate_limited" ||
              errorCode === "invalid_input"
                ? t(`errors.${errorCode}`)
                : t("errors.generic")}
            </p>
          )}

          <div className="mt-3.5 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              data-testid={`${testId}-submit`}
              className="rounded-[2px] border-[1.5px] border-ink bg-ink px-3.5 py-1.5 font-mono text-[12px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:opacity-60"
            >
              {t("submit")}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-[2px] border border-line px-3.5 py-1.5 font-mono text-[12px] text-meta hover:border-ink hover:text-ink"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
