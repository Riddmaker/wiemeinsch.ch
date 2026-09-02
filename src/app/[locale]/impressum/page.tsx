import { getTranslations } from "next-intl/server";

// Statisches Impressum (UWG Art. 3 Abs. 1 lit. s), Server Component ohne Client-JS.
// Dummy-Adresse aus
// ladungsfähige Adresse ersetzen (DEPLOYMENT-Checkliste P15.5). Bewusst OHNE Telefonnummer.
const CONTACT = {
  name: "Cedric Meier",
  street: "Musterstrasse 1",
  city: "8000 Zürich",
  country: "Schweiz",
  email: "kontakt@wiemeinsch.ch",
} as const;

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
