"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
  approveAppeal,
  depublishReportedContent,
  dismissCase,
} from "@/actions/moderation";
import { useRouter } from "@/i18n/navigation";
import { RESOLUTION_NOTE_MAX } from "@/lib/validation/moderation";

/**
 * Admin-Entscheide zu einem Moderationsfall (P12.3). Jede Aktion prüft das
 * Recht erneut serverseitig — dieses UI ist reine Bequemlichkeit, keine
 * Absicherung.
 */
type Action = "dismiss" | "depublish" | "approve";

export function CaseActions({
  caseId,
  canDepublish,
  canApprove,
}: {
  caseId: string;
  canDepublish: boolean;
  canApprove: boolean;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [note, setNote] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [running, setRunning] = useState<Action | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: Action) => {
    setErrorCode(null);
    setRunning(action);
    startTransition(async () => {
      const input = { caseId, note };
      const result =
        action === "dismiss"
          ? await dismissCase(input)
          : action === "depublish"
            ? await depublishReportedContent(input)
            : await approveAppeal(input);
      setRunning(null);
      if (!result.ok) {
        setErrorCode(result.error);
        return;
      }
      router.refresh();
    });
  };

  const label = (action: Action, text: string) =>
    pending && running === action ? `${text} — ${t("actionPending")}` : text;

  return (
    <div data-testid="case-actions" className="mt-8 border-t border-line pt-6">
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[11.5px] uppercase tracking-wide text-meta">
          {t("noteLabel")}
        </span>
        <input
          type="text"
          value={note}
          maxLength={RESOLUTION_NOTE_MAX}
          onChange={(event) => setNote(event.target.value)}
          data-testid="case-note"
          className="max-w-[480px] rounded-[2px] border border-line bg-paper px-3 py-2 font-sans text-[14px] focus:border-ink focus:outline-none"
        />
      </label>

      {errorCode && (
        <p
          role="alert"
          data-testid="case-error"
          className="mt-3 border border-signal bg-signal-bg px-4 py-2.5 font-mono text-xs text-signal"
        >
          {t.has(`errors.${errorCode}`)
            ? t(`errors.${errorCode}`)
            : t("errors.generic")}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2.5">
        {canApprove && (
          <button
            type="button"
            onClick={() => run("approve")}
            disabled={pending}
            data-testid="case-approve"
            className="rounded-[2px] border-[1.5px] border-ink bg-ink px-3.5 py-1.5 font-mono text-[12px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:opacity-60"
          >
            {label("approve", t("actionApprove"))}
          </button>
        )}
        {canDepublish && (
          <button
            type="button"
            onClick={() => run("depublish")}
            disabled={pending}
            data-testid="case-depublish"
            className="rounded-[2px] border-[1.5px] border-signal px-3.5 py-1.5 font-mono text-[12px] font-semibold text-signal hover:bg-signal-bg disabled:opacity-60"
          >
            {label("depublish", t("actionDepublish"))}
          </button>
        )}
        <button
          type="button"
          onClick={() => run("dismiss")}
          disabled={pending}
          data-testid="case-dismiss"
          className="rounded-[2px] border border-line px-3.5 py-1.5 font-mono text-[12px] text-meta hover:border-ink hover:text-ink disabled:opacity-60"
        >
          {label("dismiss", t("actionDismiss"))}
        </button>
      </div>
    </div>
  );
}
