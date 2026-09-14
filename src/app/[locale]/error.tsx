"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

/**
 * Fehler-Boundary innerhalb einer Sprachfassung (P13.6).
 *
 * Der `error`-Prop wird BEWUSST nicht angezeigt: In Produktion reicht Next
 * ohnehin nur eine generische Meldung plus `digest` an den Client, aber die
 * Boundary ist der Ort, an dem versehentlich doch `error.message` oder ein
 * Stack ins UI geraten würde. Genau das ist hier ausgeschlossen (T13:
 * generische Fehlermeldung, kein Stack-Trace im Response).
 */
export default function LocaleError({ reset }: { reset: () => void }) {
  const t = useTranslations("errors");

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-5 sm:py-24">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("errorTitle")}
      </h1>
      <p className="mt-4 border border-signal bg-signal-bg px-4 py-3 font-serif leading-relaxed text-signal">
        {t("errorBody")}
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-[2px] border border-ink bg-ink px-4 py-2 font-mono text-sm font-bold text-paper hover:bg-paper hover:text-ink"
        >
          {t("retry")}
        </button>
        <Link
          href="/"
          className="font-mono text-sm underline underline-offset-4"
        >
          {t("backHome")}
        </Link>
      </div>
    </div>
  );
}
