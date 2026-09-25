import { prisma } from "@/lib/prisma";
import { purgeExpiredRateLimits } from "@/lib/rate-limit";

/**
 * Aufbewahrungsfristen durchsetzen (25.09.2026).
 *
 * NextAuth löscht einen Anmelde-Link erst, wenn er benutzt wird, und eine
 * Session erst, wenn sie nach Ablauf noch einmal gelesen wird. Nie benutzte
 * Links (mit der E-Mail-Adresse als `identifier`) und verlassene Sessions
 * blieben sonst für immer liegen — die Datenschutzerklärung nennt aber
 * Fristen. Läuft im stündlichen Cron-Takt.
 */
export async function purgeExpiredData(): Promise<{
  rateLimits: number;
  verificationTokens: number;
  sessions: number;
}> {
  const now = new Date();
  const rateLimits = await purgeExpiredRateLimits();
  const { count: verificationTokens } =
    await prisma.verificationToken.deleteMany({
      where: { expires: { lt: now } },
    });
  const { count: sessions } = await prisma.session.deleteMany({
    where: { expires: { lt: now } },
  });
  return { rateLimits, verificationTokens, sessions };
}
