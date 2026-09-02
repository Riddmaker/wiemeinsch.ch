import { prisma } from "@/lib/prisma";
import { authenticatedUserId } from "@/lib/require-user";

/**
 * Einziger erlaubter Weg, Admin-Rechte zu prüfen (P12.3) — analog zu
 * `require-user.ts`. Das Flag wird bei JEDEM Aufruf frisch aus der DB gelesen
 * und nie aus dem Session-Token abgeleitet: ein entzogenes Recht wirkt sofort,
 * und ein manipuliertes Token bringt niemanden in die Queue.
 *
 * Rückgabe ist die User-Id (nicht ein Boolean), damit Aufrufer sie für die
 * Mutation weiterverwenden können, ohne die Session erneut zu lesen.
 */
export async function adminUserId(): Promise<string | null> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  });
  return user?.isAdmin === true ? userId : null;
}
