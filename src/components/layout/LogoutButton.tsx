"use client";

import { signOut } from "next-auth/react";
import { useLocale, useTranslations } from "next-intl";

/**
 * Abmelden (P11.5). NextAuth beendet die Session serverseitig und leitet auf
 * das Board der aktuellen Sprache zurück — kein clientseitiges Aufräumen.
 */
export function LogoutButton() {
  const t = useTranslations("header");
  const locale = useLocale();

  return (
    <button
      type="button"
      data-testid="header-logout"
      onClick={() => void signOut({ callbackUrl: `/${locale}` })}
      className="font-mono text-xs text-meta underline underline-offset-2 hover:text-ink"
    >
      {t("logout")}
    </button>
  );
}
