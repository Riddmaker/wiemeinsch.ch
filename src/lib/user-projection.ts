import type { Prisma } from "@/generated/prisma/client";

/**
 * Öffentliche User-Projektion (nDSG,; P2.5/P11).
 *
 * Dies ist der EINZIGE erlaubte Weg, Userdaten nach aussen zu geben — jede
 * öffentliche Route/Action verwendet dieses `select`. Demografische Felder
 * (Jahrgang, Geschlecht, Bildung, PLZ, Beruf) und E-Mail sind bewusst
 * ausgeschlossen; ein dauerhafter Regressionstest erzwingt das
 * (tests/unit/user-projection.test.ts).
 */
export const publicUserSelect = {
  id: true,
  handle: true,
  name: true,
  image: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{
  select: typeof publicUserSelect;
}>;

/** Serverseitig private Spalten — dürfen NIE in einer öffentlichen Antwort auftauchen. */
export const privateUserFields = [
  "birthYear",
  "gender",
  "education",
  "postalCode",
  "occupation",
  "email",
  "emailVerified",
  "isAdmin",
  // Lesemarke der Benachrichtigungen (E14): verrät, wann jemand zuletzt
  // hereingeschaut hat — ein Aktivitätsmuster, das niemanden etwas angeht.
  "notificationsReadAt",
] as const satisfies readonly Prisma.UserScalarFieldEnum[];
