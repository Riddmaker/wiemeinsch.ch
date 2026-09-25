import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export class UnauthorizedError extends Error {
  constructor() {
    super("UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

/**
 * Session vorhanden, aber keine Einwilligung in die aktuelle
 * Datenschutzerklärung. Unterklasse, damit jede bestehende Action sie wie
 * «unauthorized» behandelt; die Oberfläche leitet vorher auf die
 * Zustimmungsseite um, diese Schicht ist die serverseitige Absicherung.
 */
export class ConsentRequiredError extends UnauthorizedError {
  constructor() {
    super();
    this.name = "ConsentRequiredError";
  }
}

/**
 * Einziger erlaubter Weg, Identität in Server Actions zu prüfen (P4.7).
 * Wirft VOR jeder Mutation — eine Action ohne gültige Session erreicht die DB nie.
 *
 * Seit 25.09.2026 verlangt sie auch die Einwilligung in die aktuelle
 * Datenschutzerklärung: Ohne sie darf nichts öffentlich werden. Nur Actions,
 * die nichts veröffentlichen (Zustimmung selbst, Sprachwechsel), rufen mit
 * `{ consent: false }` auf.
 */
export async function requireUser(
  options: { consent?: boolean } = {},
): Promise<{ id: string }> {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id;
  if (!id) {
    throw new UnauthorizedError();
  }
  if (options.consent !== false && session.user.privacyConsent !== true) {
    throw new ConsentRequiredError();
  }
  return { id };
}

/**
 * requireUser als Result statt Exception — für Actions, die "unauthorized"
 * als Fehlercode zurückgeben (geteilt von tickets/votes/statements, P9 DRY).
 */
export async function authenticatedUserId(): Promise<string | null> {
  try {
    const { id } = await requireUser();
    return id;
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return null;
    }
    throw e;
  }
}
