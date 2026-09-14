import { getTranslations } from "next-intl/server";

// Ziel von pages.verifyRequest — identische Antwort für bekannte wie unbekannte
// Adressen (E-Mail-Enumeration-Schutz, P4-Stolperstein).
export default async function CheckEmailPage() {
  const t = await getTranslations("login");

  return (
    <div className="mx-auto max-w-md px-4 py-10 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("checkEmailTitle")}
      </h1>
      <p className="mt-4 font-serif leading-relaxed">{t("checkEmailText")}</p>
    </div>
  );
}
