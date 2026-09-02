"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { voteOnStatement, voteOnTicket } from "@/actions/votes";
import { LoginHint } from "@/components/auth/LoginHint";
import type { VoteChoice } from "@/lib/validation/vote";

/**
 * Interaktives Voting (P8.3/E1, ab P9 auch für Statements): Klick = abstimmen,
 * Klick auf eigene Stimme = zurückziehen, Gegenklick = umschalten.
 * ▲/▼ IMMER getrennt (Styleguide Art. 6/7) — nie ein Netto-Score.
 */

type Props = {
  /** Ziel der Stimme — bestimmt Action und data-testid-Präfix. */
  target: { kind: "ticket" | "statement"; id: string };
  initialUpvotes: number;
  initialDownvotes: number;
  initialMyVote: VoteChoice | null;
  isLoggedIn: boolean;
  /** Kompakte Darstellung für Statement-Cards (Styleguide Art. 7). */
  compact?: boolean;
};

const BUTTON_CLASSES =
  "inline-flex items-center gap-2 rounded-[2px] border border-line bg-paper " +
  "font-mono font-bold hover:border-ink disabled:opacity-60 " +
  "aria-pressed:border-ink aria-pressed:bg-surface";

export function VoteButtons({
  target,
  initialUpvotes,
  initialDownvotes,
  initialMyVote,
  isLoggedIn,
  compact = false,
}: Props) {
  const t = useTranslations("ticketDetail.vote");
  const locale = useLocale();
  const [counts, setCounts] = useState({
    upvotes: initialUpvotes,
    downvotes: initialDownvotes,
  });
  const [myVote, setMyVote] = useState<VoteChoice | null>(initialMyVote);
  const [notice, setNotice] = useState<
    "login" | "rate_limited" | "invalid_input" | null
  >(null);
  const [pending, startTransition] = useTransition();

  const chNumber = new Intl.NumberFormat(`${locale}-CH`);
  const testIdPrefix = target.kind === "ticket" ? "vote" : "statement-vote";
  const sizeClasses = compact
    ? "px-2.5 py-1 text-[12px]"
    : "px-3.5 py-1.5 text-[13px]";

  const cast = (value: VoteChoice) => {
    if (!isLoggedIn) {
      setNotice("login");
      return;
    }
    startTransition(async () => {
      const result =
        target.kind === "ticket"
          ? await voteOnTicket({ ticketId: target.id, value })
          : await voteOnStatement({ statementId: target.id, value });
      if (result.ok) {
        setCounts({ upvotes: result.upvotes, downvotes: result.downvotes });
        setMyVote(result.myVote);
        setNotice(null);
      } else {
        setNotice(result.error === "unauthorized" ? "login" : result.error);
      }
    });
  };

  return (
    <div data-testid={`${testIdPrefix}-buttons`}>
      <div className={`flex items-center ${compact ? "gap-2.5" : "gap-3.5"}`}>
        <button
          type="button"
          data-testid={`${testIdPrefix}-up`}
          aria-pressed={myVote === "UP"}
          disabled={pending}
          onClick={() => cast("UP")}
          className={`${BUTTON_CLASSES} ${sizeClasses} text-pro`}
        >
          <span aria-hidden="true">▲</span>
          <span className="sr-only">{t("up")}: </span>
          {chNumber.format(counts.upvotes)}
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-down`}
          aria-pressed={myVote === "DOWN"}
          disabled={pending}
          onClick={() => cast("DOWN")}
          className={`${BUTTON_CLASSES} ${sizeClasses} text-meta`}
        >
          <span aria-hidden="true">▼</span>
          <span className="sr-only">{t("down")}: </span>
          {chNumber.format(counts.downvotes)}
        </button>
      </div>

      {notice === "login" && (
        <LoginHint
          message={t("loginHint")}
          linkLabel={t("loginLink")}
          testId={`${testIdPrefix}-login-hint`}
        />
      )}
      {(notice === "rate_limited" || notice === "invalid_input") && (
        <p className="mt-2.5 font-mono text-xs text-signal">
          {t(`errors.${notice}`)}
        </p>
      )}
    </div>
  );
}
