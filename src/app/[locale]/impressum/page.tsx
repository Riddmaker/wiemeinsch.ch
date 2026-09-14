import { getTranslations } from "next-intl/server";
import { CONTACT } from "@/lib/contact";

// Statisches Impressum (UWG Art. 3 Abs. 1 lit. s), Server Component ohne Client-JS.
// Die Angaben selbst stehen in lib/contact.ts (auch von der Presse-Seite genutzt).

export default async function ImpressumPage() {
  const t = await getTranslations("impressum");

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("title")}
      </h1>
      <p className="mt-6 font-serif leading-relaxed">{t("responsible")}</p>
      <address className="mt-4 font-serif not-italic leading-relaxed">
        {CONTACT.name}
        <br />
        {CONTACT.street}
        <br />
        {CONTACT.city}
        <br />
        {CONTACT.country}
      </address>
      <p className="mt-4 font-serif leading-relaxed">
        {t("emailLabel")}:{" "}
        <a
          href={`mailto:${CONTACT.email}`}
          className="underline underline-offset-4"
        >
          {CONTACT.email}
        </a>
      </p>
    </div>
  );
}
