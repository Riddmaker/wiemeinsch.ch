"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { updateProfile } from "@/actions/profile";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import {
  BIRTH_YEAR_MIN,
  currentBirthYearMax,
  EDUCATION_LEVELS,
  GENDERS,
  OCCUPATION_MAX,
  profileSettingsSchema,
} from "@/lib/validation/profile";

/**
 * Eigene Profil-Einstellungen (P11.3, Styleguide Art. 5): ein schlichtes
 * Formular ohne Editor — die Demografie-Felder sind FREIWILLIG, «Keine
 * Angabe» ist überall die Vorauswahl und speichert `null`.
 *
 * Validiert wird mit demselben Zod-Schema wie in der Server Action
 * (lib/validation/profile.ts) — der Client zeigt den Fehler nur früher an.
 */

export type ProfileSettingsValues = {
  preferredLocale: string;
  birthYear: string;
  gender: string;
  education: string;
  postalCode: string;
  occupation: string;
};

const FIELD_CLASSES =
  "rounded-[2px] border border-line bg-paper px-3 py-2.5 text-[15px] focus:border-ink";
const LABEL_CLASSES =
  "font-mono text-[11.5px] uppercase tracking-wide text-meta";

export function ProfileSettingsForm({
  initialValues,
  handle,
  profileHref,
}: {
  initialValues: ProfileSettingsValues;
  handle: string | null;
  profileHref: string;
}) {
  const t = useTranslations("settings");
  const tRoot = useTranslations();

  const [values, setValues] = useState<ProfileSettingsValues>(initialValues);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const maxBirthYear = currentBirthYearMax();

  const setField = (field: keyof ProfileSettingsValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setStatus("idle");
    setErrorCode(null);
  };

  const errorText = (code: string): string =>
    t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.invalid_input");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = profileSettingsSchema.safeParse(values);
    if (!parsed.success) {
      setErrorCode(parsed.error.issues[0]?.message ?? "invalid_input");
      return;
    }
    setErrorCode(null);
    setStatus("saving");
    const result = await updateProfile(values);
    if (!result.ok) {
      setErrorCode(result.error);
      setStatus("idle");
      return;
    }
    setStatus("saved");
  };

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="mt-8 flex max-w-[520px] flex-col gap-8"
      data-testid="settings-form"
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta">
          {t("languageHeading")}
        </legend>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASSES}>{t("languageLabel")}</span>
          <select
            name="preferredLocale"
            data-testid="settings-preferredLocale"
            value={values.preferredLocale}
            onChange={(event) =>
              setField("preferredLocale", event.target.value)
            }
            className={FIELD_CLASSES}
          >
            {routing.locales.map((locale) => (
              <option key={locale} value={locale.toUpperCase()}>
                {tRoot(`localeSwitcher.${locale}`)}
              </option>
            ))}
          </select>
        </label>
        <p className="font-mono text-xs leading-relaxed text-meta">
          {t("languageHint")}
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta">
          {t("demographyHeading")}
        </legend>
        <p
          data-testid="settings-privacy-note"
          className="max-w-prose font-serif text-[15px] leading-relaxed text-ink"
        >
          {t("privacyNote")}
        </p>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASSES}>{t("birthYear")}</span>
          <input
            type="number"
            name="birthYear"
            data-testid="settings-birthYear"
            inputMode="numeric"
            min={BIRTH_YEAR_MIN}
            max={maxBirthYear}
            value={values.birthYear}
            onChange={(event) => setField("birthYear", event.target.value)}
            className={FIELD_CLASSES}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASSES}>{t("gender")}</span>
          <select
            name="gender"
            data-testid="settings-gender"
            value={values.gender}
            onChange={(event) => setField("gender", event.target.value)}
            className={FIELD_CLASSES}
          >
            <option value="">{t("noAnswer")}</option>
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {t(`genders.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASSES}>{t("education")}</span>
          <select
            name="education"
            data-testid="settings-education"
            value={values.education}
            onChange={(event) => setField("education", event.target.value)}
            className={FIELD_CLASSES}
          >
            <option value="">{t("noAnswer")}</option>
            {EDUCATION_LEVELS.map((value) => (
              <option key={value} value={value}>
                {t(`educations.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASSES}>{t("postalCode")}</span>
          <input
            type="text"
            name="postalCode"
            data-testid="settings-postalCode"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={4}
            value={values.postalCode}
            onChange={(event) => setField("postalCode", event.target.value)}
            className={FIELD_CLASSES}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL_CLASSES}>{t("occupation")}</span>
          <input
            type="text"
            name="occupation"
            data-testid="settings-occupation"
            maxLength={OCCUPATION_MAX}
            value={values.occupation}
            onChange={(event) => setField("occupation", event.target.value)}
            className={FIELD_CLASSES}
          />
          <span className="font-mono text-xs text-meta">
            {t("occupationHint")}
          </span>
        </label>
      </fieldset>

      {errorCode && (
        <p
          role="alert"
          data-testid="settings-error"
          className="border border-signal bg-signal-bg px-4 py-3 font-mono text-xs text-signal"
        >
          {errorText(errorCode)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          data-testid="settings-save"
          disabled={status === "saving"}
          className="rounded-[2px] border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[14.5px] font-semibold text-paper hover:bg-[#2e2e2e] disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-meta"
        >
          {status === "saving" ? t("saving") : t("save")}
        </button>
        {status === "saved" && (
          <span
            role="status"
            data-testid="settings-saved"
            className="font-mono text-xs text-meta"
          >
            {t("saved")}
          </span>
        )}
        {handle && (
          <Link
            href={profileHref}
            className="font-mono text-xs text-meta underline underline-offset-2 hover:text-ink"
          >
            {t("publicProfile")}
          </Link>
        )}
      </div>
    </form>
  );
}
