import { getServerSession } from "next-auth";
import { getTranslations } from "next-intl/server";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { Link } from "@/i18n/navigation";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { SwissCrossLogo } from "./SwissCrossLogo";

// Header gemäss Styleguide Art. 2: Logo oben links, Navigation (font-sans),
// Sprachwahl (font-mono), primäre Aktion — sonst nichts. Keine fixen Breiten (FR +15–20 %).
// Eingeloggt ersetzt der eigene @handle (Link aufs Profil) den Anmelde-Button;
// über das Profil sind die Einstellungen erreichbar (P11.5).
export async function AppHeader() {
  const t = await getTranslations();

  const session = await getServerSession(authOptions);
  const userId = session?.user?.id ?? null;
  const me = userId
    ? await prisma.user.findUnique({
        where: { id: userId },
        select: { handle: true, isAdmin: true },
      })
    : null;

  return (
    <header className="flex items-center gap-4 border-b border-line bg-paper px-4 py-3.5 sm:gap-7 sm:px-5">
      <Link href="/" className="flex shrink-0 items-center gap-2.5">
        <SwissCrossLogo
          label={t("app.logoAria")}
          className="h-6 w-6 sm:h-7 sm:w-7"
        />
        <span className="font-mono text-sm font-bold tracking-tight sm:text-base">
          {t("app.name")}
        </span>
      </Link>

      <nav className="hidden gap-5 sm:flex">
        <Link
          href="/"
          className="text-[14.5px] font-medium text-ink underline-offset-[6px] hover:underline"
        >
          {t("header.board")}
        </Link>
        <Link
          href="/tickets/new"
          className="text-[14.5px] font-medium text-ink underline-offset-[6px] hover:underline"
        >
          {t("header.submit")}
        </Link>
      </nav>

      <div className="ml-auto flex items-center gap-2 sm:gap-4">
        <LocaleSwitcher isLoggedIn={userId !== null} />
        {userId ? (
          // Wie Navigation und Anmelde-Button (P3) erst ab `sm`: bei 375 px
          // reichen Logo, Sprachwahl, @handle und Abmelden sonst über den Rand
          // hinaus. Auf dem Profil landet man mobil über die @handle-Links in
          // den Meta-Zeilen von Tickets, Statements und Anträgen.
          <div className="hidden items-center gap-4 sm:flex">
            {me?.isAdmin && (
              <Link
                href="/admin"
                data-testid="header-admin"
                className="font-mono text-[13px] font-bold uppercase tracking-wide text-meta underline-offset-[6px] hover:text-ink hover:underline"
              >
                {t("header.admin")}
              </Link>
            )}
            <Link
              href={`/profil/${userId}`}
              data-testid="header-profile"
              className="max-w-[16ch] truncate font-mono text-[13px] font-bold text-ink underline-offset-[6px] hover:underline"
            >
              {me?.handle ? `@${me.handle}` : t("header.profile")}
            </Link>
            <LogoutButton />
          </div>
        ) : (
          <Link
            href="/login"
            className="hidden rounded-[2px] border-[1.5px] border-ink bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-paper hover:bg-[#2e2e2e] sm:inline-block"
          >
            {t("header.login")}
          </Link>
        )}
      </div>
    </header>
  );
}
