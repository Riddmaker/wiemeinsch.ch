import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CONTACT } from "@/lib/contact";

/**
 * Datenschutzerklärung (Code-Review 25.09.2026, DSG Art. 19).
 *
 * Statisch wie das Impressum; die Angaben zum Verantwortlichen kommen aus
 * lib/contact.ts, die Texte aus `messages/`. Jede Aussage entspricht dem,
 * was der Code tatsächlich tut — ändert sich dort etwas (neuer Anbieter,
 * andere Aufbewahrung), muss dieser Text mit. Wesentliche Änderungen
 * verlangen zusätzlich eine neue Version in lib/privacy-consent.ts, damit
 * alle erneut gefragt werden.
 */

const SECTIONS = [
  "consent",
  "data",
  "public",
  "reuse",
  "purposes",
  "recipients",
  "abroad",
  "retention",
  "storage",
  "rights",
  "changes",
] as const;

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/datenschutz">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "privacy" });
  return { title: t("metaTitle") };
}

export default async function PrivacyPage() {
  const t = await getTranslations("privacy");
  const prose = "mt-4 max-w-prose font-serif leading-relaxed";
  const heading =
    "border-t-2 border-ink pt-5 font-serif text-2xl font-bold leading-tight";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-prose font-serif text-lg leading-relaxed">
        {t("lead")}
      </p>
      <p className="mt-3 font-mono text-xs text-meta">{t("updated")}</p>

      <section aria-labelledby="responsible" className="mt-12">
        <h2 id="responsible" className={heading}>
          {t("responsible.title")}
        </h2>
        <p className={prose}>{t("responsible.body")}</p>
        <address className="mt-3 font-serif not-italic leading-relaxed">
          {CONTACT.name}
          <br />
          {CONTACT.street}
          <br />
          {CONTACT.city}
          <br />
          {CONTACT.country}
          <br />
          <a
            href={`mailto:${CONTACT.email}`}
            className="underline underline-offset-4"
          >
            {CONTACT.email}
          </a>
        </address>
        <p className={prose}>{t("responsible.contact")}</p>
      </section>

      {SECTIONS.map((section) => (
        <section key={section} aria-labelledby={section} className="mt-12">
          <h2 id={section} className={heading}>
            {t(`${section}.title`)}
          </h2>
          {t(`${section}.body`)
            .split("\n\n")
            .map((paragraph, index) => (
              <p key={index} className={prose}>
                {paragraph}
              </p>
            ))}
        </section>
      ))}
    </div>
  );
}
