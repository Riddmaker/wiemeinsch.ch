"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { rerollAvatar } from "@/actions/profile";
import { Avatar } from "@/components/profile/Avatar";
import { callAction } from "@/lib/call-action";

/**
 * Eigenes Profilbild mit «Neues Bild» (27.09.2026): Ein Klick würfelt auf
 * dem Server einen neuen Seed; das Bild wechselt sofort, der Refresh zieht
 * Header und Beiträge nach.
 */
export function AvatarReroll({
  seed: initialSeed,
  className,
}: {
  seed: string;
  className: string;
}) {
  const t = useTranslations("profile.avatar");
  const router = useRouter();
  const [seed, setSeed] = useState(initialSeed);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        data-testid="avatar-reroll"
        disabled={pending}
        aria-label={t("reroll")}
        title={t("reroll")}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await callAction(() => rerollAvatar());
            if (!result) return;
            if (!result.ok) {
              setError(
                t(
                  result.error === "rate_limited"
                    ? "errors.rateLimited"
                    : "errors.generic",
                ),
              );
              return;
            }
            setSeed(result.seed);
            router.refresh();
          });
        }}
        className="rounded-[2px] outline-offset-[3px] transition-opacity focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-60"
      >
        <Avatar seed={seed} className={className} />
      </button>
      {error && (
        <p role="alert" className="font-mono text-xs text-signal">
          {error}
        </p>
      )}
    </div>
  );
}
