import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export class UnauthorizedError extends Error {
  constructor() {
    super("UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

/**
 * Einziger erlaubter Weg, Identität in Server Actions zu prüfen (P4.7).
 * Wirft VOR jeder Mutation — eine Action ohne gültige Session erreicht die DB nie.
 */
export async function requireUser(): Promise<{ id: string }> {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id;
  if (!id) {
    throw new UnauthorizedError();
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
