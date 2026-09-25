import type { DefaultSession } from "next-auth";

// Session-User um die DB-Id und den Einwilligungsstand erweitern (gesetzt im
// session-Callback, lib/auth.ts, bei jedem Lesen frisch aus der DB).
declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & { id: string; privacyConsent: boolean };
  }
}
