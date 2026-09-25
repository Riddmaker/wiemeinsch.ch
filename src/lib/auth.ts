import { PrismaAdapter } from "@auth/prisma-adapter";
import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import { routing } from "@/i18n/routing";
import { normalizeEmailIdentifier } from "@/lib/email-identifier";
import { assignHandle } from "@/lib/handle";
import { toDbLocale } from "@/lib/locale";
import { sendMagicLink } from "@/lib/magic-link-mail";
import { prisma } from "@/lib/prisma";
import { hasCurrentConsent } from "@/lib/privacy-consent";
import { checkRateLimit } from "@/lib/rate-limit";
import { signupLocaleContext } from "@/lib/signup-locale";

// NextAuth v4.24 (Auth.js-v5 ist weiterhin Beta — Stabilitätsregel, Versions-Log).

export function isGoogleLoginEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
}

/** Magic Links pro Adresse und Fenster (P4: 5 je 15 Minuten). */
export const MAGIC_LINK_LIMIT = { limit: 5, windowSeconds: 900 };

const providers: NextAuthOptions["providers"] = [];

if (isGoogleLoginEnabled()) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      // Datensparsamkeit (25.09.2026): Google liefert Klarnamen und Profilbild.
      // Die Plattform zeigt ausschliesslich den zufälligen @handle — beides
      // zu speichern, hiesse eine Deanonymisierung auf Vorrat anzulegen.
      profile(profile) {
        return {
          id: profile.sub,
          email: profile.email,
          name: null,
          image: null,
        };
      },
    }),
  );
}

const smtpPort = Number(process.env.SMTP_PORT ?? 587);

providers.push(
  EmailProvider({
    server: {
      host: process.env.SMTP_HOST,
      port: smtpPort,
      // 465 = implizites TLS; 587 = STARTTLS, und zwar Pflicht: Ohne
      // `requireTLS` schickte nodemailer die Zugangsdaten im Klartext, wenn
      // ein Angreifer das STARTTLS-Angebot des Servers unterdrückt.
      secure: smtpPort === 465,
      requireTLS: smtpPort === 587,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    },
    from: process.env.EMAIL_FROM,
    // Magic-Link-Gültigkeit: 1 Stunde (v4-Default wäre 24h — bewusst verkürzt).
    maxAge: 60 * 60,
    // Strenger als NextAuths eigene Normalisierung (lib/email-identifier.ts):
    // Kommas, Leerzeichen und Überlängen erreichen weder Limit noch Versand.
    normalizeIdentifier: normalizeEmailIdentifier,
    // Mail in der Sprache der Anmeldung statt NextAuths englischem Template.
    sendVerificationRequest: sendMagicLink,
  }),
);

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as Adapter,
  providers,
  session: { strategy: "database" },
  pages: {
    // Pfade ohne Locale — der next-intl-Proxy leitet auf die erkannte Sprache um.
    signIn: "/login",
    verifyRequest: "/login/check-email",
    error: "/login/error",
  },
  callbacks: {
    /**
     * Limit der Magic Links pro Adresse (25.09.2026 hierher verlegt).
     *
     * Vorher zählte die Auth-Route selbst — mit drei Lücken: Sie las das
     * ERSTE `email`-Feld, NextAuth mailte an das LETZTE; sie normalisierte
     * schwächer als NextAuth (Komma, NFKC); und sie zählte vor Turnstile und
     * CSRF, sodass sechs einfache POSTs die Adresse eines anderen sperrten.
     * Hier läuft das Limit erst nach CSRF-Prüfung (NextAuth) und Turnstile
     * (Route), und der Schlüssel ist genau die Adresse, an die die Mail geht.
     */
    async signIn({ account, email }) {
      if (email?.verificationRequest && account?.provider === "email") {
        const limit = await checkRateLimit({
          scope: "auth-email",
          identifier: account.providerAccountId,
          ...MAGIC_LINK_LIMIT,
        });
        if (!limit.ok) {
          return "/login/error?error=RateLimit";
        }
      }
      return true;
    },
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // Datenbank-Sessions: `user` ist die ganze User-Zeile, frisch bei
        // jedem Lesen (PrismaAdapter.getSessionAndUser) — eine Einwilligung
        // oder eine neue Version wirkt sofort, ohne neues Login.
        session.user.privacyConsent = hasCurrentConsent(
          (user as { privacyConsentVersion?: string | null })
            .privacyConsentVersion,
        );
      }
      return session;
    },
    redirect({ url, baseUrl }) {
      // Open-Redirect-Schutz: nur relative Pfade oder eigene Origin (P4-Stolperstein).
      if (url.startsWith("/")) {
        return `${baseUrl}${url}`;
      }
      try {
        if (new URL(url).origin === baseUrl) {
          return url;
        }
      } catch {
        // ungültige URL → Startseite
      }
      return baseUrl;
    },
  },
  events: {
    async createUser({ user }) {
      // Öffentlicher @handle: Zufallswort + Suffix, OHNE Bezug zur Mailadresse
      // (siehe lib/handle.ts — der Handle ist öffentlich und nicht änderbar).
      // Im selben Update die Sprache, in der sich die Person registriert hat
      // (lib/signup-locale.ts) — sonst landete die Romandie nach dem ersten
      // Login auf Deutsch.
      const locale = signupLocaleContext.getStore() ?? routing.defaultLocale;
      await assignHandle(user.id, { preferredLocale: toDbLocale(locale) });
    },
  },
};
