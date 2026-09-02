import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

// Footer mit Impressum-Link — aus jeder Seite erreichbar (Pflichtangabe).
export async function AppFooter() {
  const t = await getTranslations("footer");

  return (
    <footer className="border-t border-line bg-paper px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs text-meta">
        <Link
          href="/impressum"
          className="underline underline-offset-4 hover:text-ink"
        >
          {t("impressum")}
        </Link>
        <span>{t("license")}</span>
      </div>
    </footer>
  );
}
