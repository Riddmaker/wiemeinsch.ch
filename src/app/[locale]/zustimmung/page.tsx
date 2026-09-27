import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { getTranslations } from "next-intl/server";
import { ConsentForm } from "@/components/auth/ConsentForm";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { authOptions } from "@/lib/auth";
import { assignHandle } from "@/lib/handle";
import { prisma } from "@/lib/prisma";
import { PRIVACY_POLICY_VERSION, safeNextPath } from "@/lib/privacy-consent";

/**
 * Ausdrückliche Einwilligung nach dem Login (25.09.2026, lib/privacy-consent.ts).
 *
 * Neu gefasst am 27.09.2026 (User-freigegeben): Die alte Fassung begann mit
 * «Deine Abstimmungen sind öffentlich … politische Ansichten» und wirkte
 * abschreckend, und sie liess offen, dass Mistral keine Personendaten
 * erhält. Aufbau jetzt: Was öffentlich ist → warum wir ausdrücklich fragen →
 * EIN Einwilligungssatz direkt über den Knöpfen (DSG Art. 6 Abs. 7: Risiko
 * und «politische Haltung» müssen dort stehen) → «Gut zu wissen», getrennt
 * von der Einwilligung. Der eigene Zufallsname steht im Text, damit klar
 * ist, was die anderen sehen.
 */

const FACTS = ["ai", "demographics", "email", "storage", "withdraw"] as const;

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/zustimmung">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "consent" });
  return { title: t("metaTitle"), robots: { index: false } };
}

export default async function ConsentPage({
  params,
  searchParams,
}: PageProps<"/[locale]/zustimmung">) {
  // Die Locale hat das Layout bereits geprüft (hasLocale).
  const locale = (await params).locale as AppLocale;
  const { next: rawNext } = await searchParams;
  const next = safeNextPath(rawNext, locale);

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }
  if (session.user.privacyConsent) {
    redirect(next);
  }

  // Das Layout vergibt einen fehlenden Handle nach, rendert aber parallel
  // zur Seite — deshalb hier dieselbe Nachvergabe statt eines leeren Namens.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { handle: true },
  });
  const handle = `@${user?.handle ?? (await assignHandle(session.user.id))}`;

  const t = await getTranslations("consent");
  const handleTag = (chunks: ReactNode) => (
    <span className="font-mono text-[0.9em] font-bold">{chunks}</span>
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-5 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-prose font-serif text-lg leading-relaxed">
        {t.rich("lead", { name: handleTag, handle })}
      </p>

      <section className="mt-8 max-w-prose border-t-2 border-ink pt-6">
        <h2 className="font-serif text-lg font-bold leading-snug">
          {t("why.title")}
        </h2>
        <p className="mt-1.5 font-serif leading-relaxed">
          {t.rich("why.body", { name: handleTag, handle })}
        </p>
      </section>

      <section
        aria-labelledby="consent-statement"
        className="mt-8 border-t-2 border-ink pt-6"
      >
        <p
          id="consent-statement"
          data-testid="consent-statement"
          className="max-w-prose font-serif text-lg font-bold leading-relaxed"
        >
          {t("statement")}
        </p>
        <ConsentForm version={PRIVACY_POLICY_VERSION} next={next} />
      </section>

      <section className="mt-10 max-w-prose border-t border-line pt-6">
        <h2 className="font-serif text-lg font-bold leading-snug">
          {t("facts.title")}
        </h2>
        <ul className="mt-3 flex flex-col gap-3">
          {FACTS.map((fact) => (
            <li key={fact} className="font-serif leading-relaxed">
              <strong>{t(`facts.items.${fact}.title`)}</strong>{" "}
              {t(`facts.items.${fact}.body`)}
            </li>
          ))}
        </ul>
        <p className="mt-4 font-serif leading-relaxed">
          {t.rich("details", {
            link: (chunks) => (
              <Link
                href="/datenschutz"
                className="underline underline-offset-4"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      </section>
    </div>
  );
}
