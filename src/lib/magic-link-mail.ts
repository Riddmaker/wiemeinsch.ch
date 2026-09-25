import { createTranslator } from "next-intl";
import type { SendVerificationRequestParams } from "next-auth/providers/email";
import { createTransport } from "nodemailer";
import { routing, type AppLocale } from "@/i18n/routing";
import deMessages from "../../messages/de.json";
import frMessages from "../../messages/fr.json";
import itMessages from "../../messages/it.json";
import { localeFromUrl } from "@/lib/signup-locale";

/**
 * Magic-Link-Mail in der Sprache der Anmeldung (25.09.2026).
 *
 * Vorher verschickte NextAuth sein englisches Standard-Template («Sign in
 * to …») — ausgerechnet die erste Nachricht der Plattform an einen neuen
 * User, auf einer Plattform, die in drei Landessprachen arbeitet.
 *
 * Die Sprache kommt aus der `callbackUrl`, die NextAuth in den Link schreibt
 * (`/fr/…` → Französisch). Texte stehen wie alle UI-Texte in `messages/`.
 */

const MESSAGES = { de: deMessages, fr: frMessages, it: itMessages } as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Sprache des Links; ohne erkennbare Locale die Default-Sprache. */
export function magicLinkLocale(url: string): AppLocale {
  try {
    return (
      localeFromUrl(new URL(url).searchParams.get("callbackUrl"), url) ??
      routing.defaultLocale
    );
  } catch {
    return routing.defaultLocale;
  }
}

export type MagicLinkMail = {
  subject: string;
  text: string;
  html: string;
};

/** Reiner Baustein: Betreff, Text- und HTML-Fassung für einen Link. */
export function buildMagicLinkMail(url: string): MagicLinkMail {
  const locale = magicLinkLocale(url);
  const t = createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: "loginEmail",
  });

  const text = [
    t("heading"),
    "",
    t("intro"),
    "",
    url,
    "",
    t("ignore"),
    "",
  ].join("\n");

  const safeUrl = escapeHtml(url);
  // Schlichtes, tabellenloses HTML: schwarzer Knopf auf Papierweiss wie im
  // Styleguide; der Link steht zusätzlich als Text, falls der Knopf fehlt.
  const html = `<!doctype html>
<html lang="${locale}">
<body style="margin:0;padding:24px;background:#ffffff;color:#141414;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:520px;margin:0 auto;">
<p style="font-size:20px;font-weight:bold;margin:0 0 16px;">${escapeHtml(t("heading"))}</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 24px;">${escapeHtml(t("intro"))}</p>
<p style="margin:0 0 24px;"><a href="${safeUrl}" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:2px;">${escapeHtml(t("button"))}</a></p>
<p style="font-size:13px;line-height:1.6;color:#55606e;margin:0 0 8px;">${escapeHtml(t("fallback"))}</p>
<p style="font-size:13px;line-height:1.6;word-break:break-all;margin:0 0 24px;"><a href="${safeUrl}" style="color:#141414;">${safeUrl}</a></p>
<p style="font-size:13px;line-height:1.6;color:#55606e;margin:0;">${escapeHtml(t("ignore"))}</p>
</div>
</body>
</html>`;

  return { subject: t("subject"), text, html };
}

/** `sendVerificationRequest` des EmailProviders (NextAuth v4). */
export async function sendMagicLink({
  identifier,
  url,
  provider,
}: SendVerificationRequestParams): Promise<void> {
  const mail = buildMagicLinkMail(url);
  const transport = createTransport(provider.server);
  const result = await transport.sendMail({
    to: identifier,
    from: provider.from,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  // Wie das NextAuth-Standard-Template: abgewiesene Empfänger sind ein
  // Fehler, damit der User nicht auf eine Mail wartet, die nie kommt.
  const failed = [...result.rejected, ...(result.pending ?? [])].filter(
    Boolean,
  );
  if (failed.length > 0) {
    throw new Error("Magic-link email could not be sent");
  }
}
