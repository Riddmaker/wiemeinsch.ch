"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

// Sprachwahl DE/FR/IT (Styleguide Art. 2: font-mono, aktive Sprache fett +
// unterstrichen). Bleibt via i18n-Link auf der AKTUELLEN Seite (P3-Stolperstein).
export function LocaleSwitcher() {
  const t = useTranslations("localeSwitcher");
  const currentLocale = useLocale();
  const pathname = usePathname();

  return (
    <nav
      aria-label={t("label")}
      className="flex gap-0.5 font-mono text-[12.5px]"
    >
      {routing.locales.map((locale) => (
        <Link
          key={locale}
          href={pathname}
          locale={locale}
          aria-current={locale === currentLocale ? "true" : undefined}
          aria-label={t(locale)}
          className={
            locale === currentLocale
              ? "px-1.5 py-1 font-bold text-ink underline underline-offset-4"
              : "px-1.5 py-1 text-meta hover:text-ink"
          }
        >
          {locale.toUpperCase()}
        </Link>
      ))}
    </nav>
  );
}
