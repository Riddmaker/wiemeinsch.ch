"use client";

import { useLocale } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

/**
 * Hinweis für Gäste bei geschützten Interaktionen (Voten, Statement schreiben).
 * Der callbackUrl führt nach dem Login exakt auf die aktuelle Seite zurück —
 * usePathname aus i18n/navigation ist locale-los, die Locale kommt davor.
 */
export function LoginHint({
  message,
  linkLabel,
  testId,
}: {
  message: string;
  linkLabel: string;
  testId: string;
}) {
  const locale = useLocale();
  const pathname = usePathname();

  return (
    <p data-testid={testId} className="mt-2.5 font-mono text-xs text-meta">
      {message}{" "}
      <Link
        href={{
          pathname: "/login",
          query: { callbackUrl: `/${locale}${pathname}` },
        }}
        className="underline underline-offset-2 hover:text-ink"
      >
        {linkLabel}
      </Link>
    </p>
  );
}
