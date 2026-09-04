"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { setPreferredLocale } from "@/actions/profile";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { toDbLocale } from "@/lib/locale";

// Sprachwahl DE/FR/IT (Styleguide Art. 2: font-mono, aktive Sprache fett +
// unterstrichen). Bleibt via i18n-Link auf der AKTUELLEN Seite (P3-Stolperstein).
//
// E11 (04.09.2026): Angemeldete schalten damit ihre PROFILSPRACHE um — sie
// gilt für Oberfläche und Inhalt gleichermassen und ist danach auch in den
// Einstellungen sichtbar. Ein reiner Link würde nur den Pfad ändern, und der
// Layout leitete sofort wieder auf die alte Profilsprache zurück.
// Gäste haben kein Profil und wechseln weiterhin per Link.
export function LocaleSwitcher({ isLoggedIn }: { isLoggedIn: boolean }) {
  const t = useTranslations("localeSwitcher");
  const currentLocale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const classesFor = (locale: string) =>
    locale === currentLocale
      ? "px-1.5 py-1 font-bold text-ink underline underline-offset-4"
      : "px-1.5 py-1 text-meta hover:text-ink";

  return (
    <nav
      aria-label={t("label")}
      className="flex gap-0.5 font-mono text-[12.5px]"
    >
      {routing.locales.map((locale) =>
        isLoggedIn ? (
          <button
            key={locale}
            type="button"
            disabled={pending || locale === currentLocale}
            aria-current={locale === currentLocale ? "true" : undefined}
            aria-label={t(locale)}
            data-testid={`locale-${locale}`}
            onClick={() => {
              startTransition(async () => {
                await setPreferredLocale(toDbLocale(locale));
                // Erst nach dem Schreiben navigieren: Sonst käme die neue
                // Seite noch mit der alten Profilsprache zurück.
                router.replace(pathname, { locale });
                router.refresh();
              });
            }}
            className={`${classesFor(locale)} disabled:opacity-100`}
          >
            {locale.toUpperCase()}
          </button>
        ) : (
          <Link
            key={locale}
            href={pathname}
            locale={locale}
            aria-current={locale === currentLocale ? "true" : undefined}
            aria-label={t(locale)}
            data-testid={`locale-${locale}`}
            className={classesFor(locale)}
          >
            {locale.toUpperCase()}
          </Link>
        ),
      )}
    </nav>
  );
}
