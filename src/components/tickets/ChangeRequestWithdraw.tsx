"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { withdrawChangeRequest } from "@/actions/change-requests";
import { useRouter } from "@/i18n/navigation";

/**
 * Eigenen laufenden Antrag zurückziehen (E15). Zweistufig, weil der Schritt
 * nicht umkehrbar ist — ein zurückgezogener Antrag lässt sich nicht wieder
 * öffnen, nur neu stellen.
 */
export function ChangeRequestWithdraw({
  changeRequestId,
}: {
  changeRequestId: string;
}) {
  const t = useTranslations("changeRequests");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const handleWithdraw = async () => {
    setErrorCode(null);
    setBusy(true);
    try {
      const result = await withdrawChangeRequest({ changeRequestId });
      if (!result.ok) {
        setErrorCode(result.error);
        return;
      }
      setConfirming(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const secondary =
    "rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:border-line disabled:text-meta";

  if (!confirming) {
    return (
      <button
        type="button"
        data-testid="change-request-withdraw"
        onClick={() => setConfirming(true)}
        className={secondary}
      >
        {t("withdraw")}
      </button>
    );
  }

  return (
    <div className="flex basis-full flex-col gap-3">
      {errorCode && (
        <p
          role="alert"
          className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
        >
          {t.has(`errors.${errorCode}`)
            ? t(`errors.${errorCode}`)
            : t("errors.invalid_input")}
        </p>
      )}
      <p className="text-[15px] leading-relaxed">{t("withdrawConfirmText")}</p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className={secondary}
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          data-testid="change-request-withdraw-confirm"
          onClick={() => void handleWithdraw()}
          disabled={busy}
          className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
        >
          {busy ? t("withdrawing") : t("confirmWithdraw")}
        </button>
      </div>
    </div>
  );
}
