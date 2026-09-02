import { getServerSession } from "next-auth";
import { getTranslations } from "next-intl/server";
import { TicketForm } from "@/components/tickets/TicketForm";
import { redirect } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Formular nur für eingeloggte User;
// die Stammdaten (26 Kantone, ~2100 Gemeinden) kommen aus P2 und werden dem
// Client fürs durchsuchbare Dropdown mitgegeben (statisch, kein Live-Request).
export default async function NewTicketPage({
  params,
}: PageProps<"/[locale]/tickets/new">) {
  const { locale } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect({
      href: {
        pathname: "/login",
        query: { callbackUrl: `/${locale}/tickets/new` },
      },
      locale,
    });
  }
  const t = await getTranslations("ticketNew");

  const cantonNameKey =
    locale === "fr" ? "nameFr" : locale === "it" ? "nameIt" : "nameDe";
  const [cantons, municipalities] = await Promise.all([
    prisma.canton.findMany({
      select: { id: true, nameDe: true, nameFr: true, nameIt: true },
    }),
    prisma.municipality.findMany({
      select: { id: true, name: true, canton: { select: { abbr: true } } },
      orderBy: { name: "asc" },
    }),
  ]);
  const cantonOptions = cantons
    .map((canton) => ({ id: canton.id, label: canton[cantonNameKey] }))
    .sort((a, b) => a.label.localeCompare(b.label, locale as AppLocale));
  const municipalityOptions = municipalities.map((municipality) => ({
    id: municipality.id,
    label: `${municipality.name} (${municipality.canton.abbr})`,
  }));

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("title")}
      </h1>
      <p className="mt-3 max-w-prose font-serif leading-relaxed text-ink">
        {t("intro")}
      </p>
      <div className="mt-8">
        <TicketForm
          cantons={cantonOptions}
          municipalities={municipalityOptions}
        />
      </div>
    </div>
  );
}
