import { getTranslations } from "next-intl/server";
import { LoginForm } from "@/components/auth/LoginForm";
import { isGoogleLoginEnabled } from "@/lib/auth";

export default async function LoginPage({
  params,
  searchParams,
}: PageProps<"/[locale]/login">) {
  const { locale } = await params;
  const sp = await searchParams;
  const t = await getTranslations("login");

  // Nur relative Pfade als Rücksprungziel akzeptieren (Open-Redirect-Schutz).
  const rawCallback = typeof sp.callbackUrl === "string" ? sp.callbackUrl : "";
  const callbackUrl =
    rawCallback.startsWith("/") && !rawCallback.startsWith("//")
      ? rawCallback
      : `/${locale}`;

  return (
    <div className="mx-auto max-w-md px-4 py-10 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("title")}
      </h1>
      <p className="mt-3 font-serif leading-relaxed text-ink">{t("intro")}</p>
      <LoginForm
        siteKey={process.env.TURNSTILE_SITE_KEY ?? ""}
        googleEnabled={isGoogleLoginEnabled()}
        callbackUrl={callbackUrl}
      />
    </div>
  );
}
