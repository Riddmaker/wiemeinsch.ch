import { getServerSession } from "next-auth";
import { getTranslations } from "next-intl/server";
import {
  ProfileSettingsForm,
  type ProfileSettingsValues,
} from "@/components/profile/ProfileSettingsForm";
import { redirect } from "@/i18n/navigation";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Eigene Profil-Einstellungen (P11.3). Die demografischen Felder werden hier
 * FREIWILLIG erfasst (Entscheid E3/E4, 30.08.2026) und verlassen den Server
 * nie pro User — diese Seite ist der einzige Ort, an dem sie überhaupt
 * ausgeliefert werden, und zwar ausschliesslich an den eigenen User.
 */
export default async function SettingsPage({
  params,
}: PageProps<"/[locale]/einstellungen">) {
  const { locale } = await params;
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) {
    return redirect({
      href: {
        pathname: "/login",
        query: { callbackUrl: `/${locale}/einstellungen` },
      },
      locale,
    });
  }

  const t = await getTranslations("settings");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      handle: true,
      preferredLocale: true,
      birthYear: true,
      gender: true,
      education: true,
      postalCode: true,
      occupation: true,
    },
  });
  if (!user) {
    // Session ohne User-Zeile (gelöschtes Konto) — zurück zur Anmeldung.
    return redirect({ href: { pathname: "/login" }, locale });
  }

  const initialValues: ProfileSettingsValues = {
    preferredLocale: user.preferredLocale,
    birthYear: user.birthYear === null ? "" : String(user.birthYear),
    gender: user.gender ?? "",
    education: user.education ?? "",
    postalCode: user.postalCode ?? "",
    occupation: user.occupation ?? "",
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("title")}
      </h1>
      <p className="mt-3 max-w-prose font-serif leading-relaxed text-ink">
        {t("intro")}
      </p>
      <ProfileSettingsForm
        initialValues={initialValues}
        handle={user.handle}
        profileHref={`/profil/${userId}`}
      />
    </div>
  );
}
