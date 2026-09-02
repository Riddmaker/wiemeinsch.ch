"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { appealLinterDecision } from "@/actions/moderation";

/**
 * Anfechtung eines Civic-Linter-Entscheids (P12.2) — der in P7 angelegte
 * Platzhalter, jetzt real. Steht EINMAL pro blockierter Einreichung neben dem
 * Blockade-Banner, nicht pro Feld: angefochten wird der Entscheid über den
 * ganzen Entwurf, und daraus wird genau ein Fall in der Moderations-Queue.
 *
 * Übergeben wird nur der Entwurf; die Linter-Gründe ermittelt der Server neu
 * (siehe actions/moderation.ts) — Findings aus dem Browser hätten in einer
 * Moderationsakte nichts verloren.
 */
export function AppealButton({
  kind,
  buildDraft,
}: {
  kind: "ticket" | "statement";
  /** Wird erst beim Klick ausgewertet — der Entwurf ändert sich bis dahin. */
  buildDraft: () => unknown;
}) {
  const t = useTranslations("linter");
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await appealLinterDecision({ kind, draft: buildDraft() });
      if (result.ok) {
        setStatus("sent");
        setMessage(t("appealSent"));
        return;
      }
      setStatus("error");
      const key =
        result.error === "not_blocked"
          ? "appealNotBlocked"
          : result.error === "rate_limited"
            ? "appealRateLimited"
            : result.error === "ai_unavailable"
              ? "appealUnavailable"
              : "appealError";
      setMessage(t(key));
    });
  };

  if (status === "sent") {
    return (
      <p
        data-testid="appeal-status"
        className="font-mono text-xs text-meta"
        role="status"
      >
        {message}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        data-testid="appeal-button"
        className="self-start font-mono text-xs text-meta underline underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? `${t("appeal")} — ${t("appealPending")}` : t("appeal")}
      </button>
      {message && (
        <p
          data-testid="appeal-status"
          role="alert"
          className="font-mono text-xs text-meta"
        >
          {message}
        </p>
      )}
    </div>
  );
}
