import type { DefaultSession } from "next-auth";

// Session-User um die DB-Id erweitern (gesetzt im session-Callback, lib/auth.ts).
declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & { id: string };
  }
}
