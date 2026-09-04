import type { Metadata } from "next";
import { headers } from "next/headers";
import { Inter, Merriweather, Space_Mono } from "next/font/google";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { AppFooter } from "@/components/layout/AppFooter";
import { AppHeader } from "@/components/layout/AppHeader";
import { routing } from "@/i18n/routing";
import { authOptions } from "@/lib/auth";
import { toAppLocale } from "@/lib/locale";
import { localeRedirectTarget } from "@/lib/locale-redirect";
import { prisma } from "@/lib/prisma";
import "../globals.css";

// Fallback-Stacks wie im Styleguide (globals.css @theme).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const merriweather = Merriweather({
  subsets: ["latin"],
  weight: ["300", "400", "700"],
  style: ["normal", "italic"],
  variable: "--font-merriweather",
});
const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
});

// Beschreibung aus dem Sprachkatalog: Sie war bis 04.09.2026 hart auf Deutsch
// verdrahtet und erschien damit auch auf /fr und /it deutsch — sichtbar in
// Suchergebnissen und beim Teilen von Links.
export async function generateMetadata({
  params,
}: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "home" });
  return { title: "wiemeinsch.ch", description: t("title") };
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // E11: Angemeldete sehen die ganze Anwendung in ihrer Profilsprache —
  // Oberfläche UND Inhalt. Ein geteilter Link in einer anderen Sprache wird
  // hierher umgeleitet. Gäste behalten die Locale aus dem Pfad.
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferredLocale: true },
    });
    if (user) {
      const pathname = (await headers()).get("x-pathname");
      const target = pathname
        ? localeRedirectTarget(pathname, toAppLocale(user.preferredLocale))
        : null;
      if (target) {
        redirect(target);
      }
    }
  }

  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={`${inter.variable} ${merriweather.variable} ${spaceMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider messages={messages}>
          <AppHeader />
          <main className="flex-1">{children}</main>
          <AppFooter />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
