"use client";

import { getCsrfToken, signIn } from "next-auth/react";
import { useTranslations } from "next-intl";
import Script from "next/script";
import { useEffect, useState } from "react";

// E-Mail-Formular postet klassisch an /api/auth/signin/email (NextAuth v4);
// der Route-Guard prüft dort Rate-Limit + Turnstile VOR dem Mailversand.
export function LoginForm({
  siteKey,
  googleEnabled,
  callbackUrl,
}: {
  siteKey: string;
  googleEnabled: boolean;
  callbackUrl: string;
}) {
  const t = useTranslations("login");
  const [csrfToken, setCsrfToken] = useState("");

  useEffect(() => {
    void getCsrfToken().then((token) => setCsrfToken(token ?? ""));
  }, []);

  return (
    <div className="mt-8 flex flex-col gap-6">
      {googleEnabled && (
        <>
          <button
            type="button"
            onClick={() => void signIn("google", { callbackUrl })}
            className="rounded-[2px] border-[1.5px] border-ink bg-paper px-5 py-2.5 text-[14.5px] font-semibold text-ink hover:bg-surface"
          >
            {t("google")}
          </button>
          <div className="flex items-center gap-3 text-meta">
            <span className="h-px flex-1 bg-line" aria-hidden />
            <span className="font-mono text-xs">{t("or")}</span>
            <span className="h-px flex-1 bg-line" aria-hidden />
          </div>
        </>
      )}

      <form
        method="post"
        action="/api/auth/signin/email"
        className="flex flex-col gap-4"
      >
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11.5px] uppercase tracking-wide text-meta">
            {t("emailLabel")}
          </span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="rounded-[2px] border border-line bg-paper px-3 py-2.5 text-[15px] focus:border-ink"
          />
        </label>

        <div className="cf-turnstile" data-sitekey={siteKey} />

        <button
          type="submit"
          disabled={!csrfToken}
          className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
        >
          {t("submit")}
        </button>
      </form>

      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        strategy="afterInteractive"
      />
    </div>
  );
}
