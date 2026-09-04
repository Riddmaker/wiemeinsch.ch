import { PrismaAdapter } from "@auth/prisma-adapter";
import type { NextAuthOptions } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import { assignHandle } from "@/lib/handle";
import { prisma } from "@/lib/prisma";

// NextAuth v4.24 (Auth.js-v5 ist weiterhin Beta — Stabilitätsregel, Versions-Log).

export function isGoogleLoginEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
}

const providers: NextAuthOptions["providers"] = [];

if (isGoogleLoginEnabled()) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    }),
  );
}

providers.push(
  EmailProvider({
    server: {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    },
    from: process.env.EMAIL_FROM,
    // Magic-Link-Gültigkeit: 1 Stunde (v4-Default wäre 24h — bewusst verkürzt).
    maxAge: 60 * 60,
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
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
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
      await assignHandle(user.id);
    },
  },
};
