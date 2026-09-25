"use client";

import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { acceptPrivacyPolicy } from "@/actions/profile";
import { callAction } from "@/lib/call-action";

/**
 * Zustimmen oder ablehnen (25.09.2026). Die angezeigte Version geht mit,
 * damit niemand einer Fassung zustimmt, die er nicht gesehen hat.
 * `next` ist serverseitig geprüft (lib/privacy-consent.ts → safeNextPath).
 */
export function ConsentForm({
  version,
  next,
}: {
  version: string;
  next: string;
}) {
  const t = useTranslations("consent");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-8 flex flex-col gap-4">
      {error && (
        <p
          role="alert"
          data-testid="consent-error"
          className="font-mono text-xs text-signal"
        >
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          data-testid="consent-accept"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await callAction(() =>
                acceptPrivacyPolicy(version),
              );
              if (!result) return;
              if (!result.ok) {
                setError(
                  t(
                    result.error === "outdated"
                      ? "errors.outdated"
                      : "errors.generic",
                  ),
                );
                return;
              }
              router.replace(next);
              router.refresh();
            });
          }}
          className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
        >
          {t("accept")}
        </button>
        <button
          type="button"
          data-testid="consent-decline"
          disabled={pending}
          onClick={() => void signOut({ callbackUrl: `/${locale}` })}
          className="rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:border-line disabled:text-meta"
        >
          {t("decline")}
        </button>
      </div>
      <p className="font-mono text-xs leading-relaxed text-meta">
        {t("declineNote")}
      </p>
    </div>
  );
}
