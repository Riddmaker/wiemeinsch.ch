import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

/**
 * Lokalisierte 404-Seite (P13.6). Ohne sie zeigt Next seine generische
 * Standardseite — englisch, ausserhalb des Layouts und im Dev mit
 * Framework-Details. Bewusst OHNE jede Angabe zur angefragten Ressource:
 * eine 404 darf nicht verraten, ob eine Id existiert (OWASP A01 — die
 * Admin-Queue und depublizierte Inhalte antworten absichtlich mit 404).
 */
export default async function LocaleNotFound() {
  const t = await getTranslations("errors");

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-5 sm:py-24">
      <p className="font-mono text-sm font-bold uppercase tracking-[0.07em] text-meta">
        404
      </p>
      <h1 className="mt-3 font-serif text-3xl font-bold leading-tight">
        {t("notFoundTitle")}
      </h1>
      <p className="mt-4 font-serif leading-relaxed">{t("notFoundBody")}</p>
      <p className="mt-8">
        <Link
          href="/"
          className="font-mono text-sm underline underline-offset-4"
        >
          {t("backHome")}
        </Link>
      </p>
    </div>
  );
}
