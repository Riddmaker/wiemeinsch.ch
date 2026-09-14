"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireUser, UnauthorizedError } from "@/lib/require-user";
import {
  dbLocaleSchema,
  profileSettingsSchema,
} from "@/lib/validation/profile";

// Muster für ALLE Server Actions (P4.7/P7.3): requireUser() → Rate-Limit →
// Zod-Validierung → Mutation. Keine rohen Fehlerdetails an den Client.

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Eigene Profil-Einstellungen speichern (P11.2): bevorzugte Sprache und die
 * FREIWILLIGEN Demografie-Felder. Schreibt ausschliesslich die validierten
 * Spalten des eigenen Users — `userId` kommt aus der Session, nie aus dem
 * Input (kein Broken Access Control, OWASP A01).
 */
export async function updateProfile(input: unknown): Promise<ActionResult> {
  let userId: string;
  try {
    ({ id: userId } = await requireUser());
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return { ok: false, error: "unauthorized" };
    }
    throw e;
  }

  const limit = await checkRateLimit({
    scope: "profile-update",
    identifier: userId,
    limit: 20,
    windowSeconds: 900,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = profileSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }

  const {
    preferredLocale,
    birthYear,
    gender,
    education,
    postalCode,
    occupation,
  } = parsed.data;
  await prisma.user.update({
    where: { id: userId },
    data: {
      preferredLocale,
      birthYear,
      gender,
      education,
      postalCode,
      occupation,
    },
  });

  // Die Anzeige-Sprache steckt in serverseitig gerenderten Seiten (P7.6) —
  // nach einem Sprachwechsel müssen die zwischengespeicherten Seiten weg.
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Sprachwahl im Header (E11, 04.09.2026).
 *
 * Der Umschalter setzt die Profilsprache — bewusst dauerhaft und nicht nur
 * für die Sitzung: Wer oben umschaltet, will die Anwendung in dieser
 * Sprache, und die Einstellung soll das danach auch zeigen. Der Wechsel ist
 * eine sichtbare Nutzerhandlung, keine versteckte Nebenwirkung.
 *
 * Eigene Action statt `updateProfile`, weil das Formular dort die
 * Demografie-Felder mitschickt; hier wird ausschliesslich eine Spalte des
 * eigenen Users geschrieben.
 */
export async function setPreferredLocale(
  input: unknown,
): Promise<ActionResult> {
  let userId: string;
  try {
    ({ id: userId } = await requireUser());
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return { ok: false, error: "unauthorized" };
    }
    throw e;
  }

  const limit = await checkRateLimit({
    scope: "locale-switch",
    identifier: userId,
    limit: 30,
    windowSeconds: 900,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = dbLocaleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { preferredLocale: parsed.data },
  });

  // Die Sprache steckt in serverseitig gerenderten Seiten — Cache leeren.
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * «Alles als gelesen markieren» (E14, 04.09.2026).
 *
 * Setzt EINEN Zeitstempel — es gibt keine Ereignistabelle, in der einzelne
 * Benachrichtigungen abgehakt würden. Danach ist der rote Punkt weg, bis
 * wieder etwas passiert.
 */
export async function markNotificationsRead(): Promise<ActionResult> {
  let userId: string;
  try {
    ({ id: userId } = await requireUser());
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return { ok: false, error: "unauthorized" };
    }
    throw e;
  }

  const limit = await checkRateLimit({
    scope: "notifications-read",
    identifier: userId,
    limit: 60,
    windowSeconds: 900,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { notificationsReadAt: new Date() },
  });

  // Der rote Punkt hängt im Header — der ist serverseitig gerendert.
  revalidatePath("/", "layout");
  return { ok: true };
}
