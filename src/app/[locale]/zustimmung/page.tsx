import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { getTranslations } from "next-intl/server";
import { ConsentForm } from "@/components/auth/ConsentForm";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { authOptions } from "@/lib/auth";
import { PRIVACY_POLICY_VERSION, safeNextPath } from "@/lib/privacy-consent";

/**
 * Ausdrückliche Einwilligung nach dem Login (25.09.2026, lib/privacy-consent.ts).
 *
 * Die Punkte sind die, für die es eine Einwilligung braucht oder die
 * jemand vor dem Mitmachen wissen muss; alles Weitere steht in der
 * Datenschutzerklärung, auf die die Seite verlinkt.
 */

const POINTS = [
  "votes",
  "reuse",
  "ai",
  "demographics",
  "email",
  "abroad",
] as const;

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

  const t = await getTranslations("consent");

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-5 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-prose font-serif text-lg leading-relaxed">
        {t("lead")}
      </p>

      <ul className="mt-8 flex flex-col gap-5 border-t-2 border-ink pt-6">
        {POINTS.map((point) => (
          <li key={point} className="max-w-prose">
            <h2 className="font-serif text-lg font-bold leading-snug">
              {t(`points.${point}.title`)}
            </h2>
            <p className="mt-1.5 font-serif leading-relaxed">
              {t(`points.${point}.body`)}
            </p>
          </li>
        ))}
      </ul>

      <p className="mt-8 max-w-prose font-serif leading-relaxed">
        {t("withdraw")}
      </p>
      <p className="mt-3 max-w-prose font-serif leading-relaxed">
        {t.rich("details", {
          link: (chunks) => (
            <Link href="/datenschutz" className="underline underline-offset-4">
              {chunks}
            </Link>
          ),
        })}
      </p>

      <ConsentForm version={PRIVACY_POLICY_VERSION} next={next} />
    </div>
  );
}
