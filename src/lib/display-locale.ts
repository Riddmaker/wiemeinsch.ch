import { getServerSession } from "next-auth";
import type { AppLocale } from "@/i18n/routing";
import { authOptions } from "@/lib/auth";
import { toAppLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";

/**
 * Anzeige-Sprache für Inhalte (P7.6/P8.4): Eingeloggte sehen ihre bevorzugte
 * Sprache, Ausgeloggte die Routen-Locale. Liefert die userId gleich mit,
 * damit Seiten keine zweite Session-Abfrage brauchen.
 */
export async function getDisplayLocale(routeLocale: AppLocale): Promise<{
  displayLocale: AppLocale;
  userId: string | null;
}> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id ?? null;
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferredLocale: true },
    });
    if (user) {
      return { displayLocale: toAppLocale(user.preferredLocale), userId };
    }
  }
  return { displayLocale: routeLocale, userId };
}
