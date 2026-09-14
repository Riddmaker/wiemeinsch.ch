import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

// Ziel von pages.error und des Auth-Guards. Fehlercode → lokalisierte Meldung;
// unbekannte Codes fallen auf eine generische Meldung zurück (kein Detail-Leak).
const KNOWN_ERRORS = ["Turnstile", "RateLimit", "Verification"] as const;

export default async function LoginErrorPage({
  searchParams,
}: PageProps<"/[locale]/login/error">) {
  const sp = await searchParams;
  const t = await getTranslations("login");

  const raw = typeof sp.error === "string" ? sp.error : "";
  const code = (KNOWN_ERRORS as readonly string[]).includes(raw)
    ? raw
    : "Default";

  return (
    <div className="mx-auto max-w-md px-4 py-10 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("errorTitle")}
      </h1>
      <p className="mt-4 border border-signal bg-signal-bg px-4 py-3 font-serif leading-relaxed text-signal">
        {t(`errors.${code}`)}
      </p>
      <p className="mt-6">
        <Link
          href="/login"
          className="font-mono text-sm underline underline-offset-4"
        >
          {t("backToLogin")}
        </Link>
      </p>
    </div>
  );
}
