"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ACTION_FAILURE_EVENT,
  type ActionFailureKind,
} from "@/lib/call-action";

/**
 * Sichtbare Meldung, wenn ein Server-Action-Aufruf wirft (siehe
 * `lib/call-action.ts`). Einmal im Layout, damit jedes Formular dieselbe
 * Meldung zeigt, ohne sie selbst zu kennen.
 *
 * «Neu laden» ist kein Automatismus: Wer gerade einen längeren Text schreibt,
 * soll ihn zuerst sichern können — deshalb lässt sich die Meldung auch
 * schliessen. Unten links, damit sie den «Nach oben»-Knopf rechts nicht
 * verdeckt.
 */
export function ActionFailureNotice() {
  const t = useTranslations("actionFailure");
  const [kind, setKind] = useState<ActionFailureKind | null>(null);

  useEffect(() => {
    const onFailure = (event: Event) => {
      const detail = (event as CustomEvent<ActionFailureKind>).detail;
      setKind(detail === "stale" ? "stale" : "failed");
    };
    window.addEventListener(ACTION_FAILURE_EVENT, onFailure);
    return () => window.removeEventListener(ACTION_FAILURE_EVENT, onFailure);
  }, []);

  return (
    <div
      role="alert"
      className="pointer-events-none fixed bottom-5 left-4 right-20 z-50 sm:left-5 sm:right-auto sm:max-w-md"
    >
      {kind && (
        <div
          data-testid="action-failure"
          data-kind={kind}
          className="pointer-events-auto border-[1.5px] border-signal bg-paper px-4 py-3 shadow-[3px_3px_0_0_var(--color-signal)]"
        >
          <p className="font-serif text-[15px] font-bold leading-snug text-signal">
            {t(`${kind}.title`)}
          </p>
          <p className="mt-1 font-serif text-sm leading-relaxed text-ink">
            {t(`${kind}.body`)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            {kind === "stale" && (
              <button
                type="button"
                data-testid="action-failure-reload"
                onClick={() => window.location.reload()}
                className="rounded-[2px] border border-ink bg-ink px-3 py-1.5 font-mono text-[13px] font-bold text-paper hover:bg-paper hover:text-ink"
              >
                {t("reload")}
              </button>
            )}
            <button
              type="button"
              data-testid="action-failure-dismiss"
              onClick={() => setKind(null)}
              className="font-mono text-[13px] underline underline-offset-4"
            >
              {t("dismiss")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
