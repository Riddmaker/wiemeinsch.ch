import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { CopyText } from "@/components/faq/CopyText";
import { SwissCrossLogo } from "@/components/layout/SwissCrossLogo";
import { Link } from "@/i18n/navigation";
import { CONTACT, SOURCE_CODE_URL } from "@/lib/contact";

/**
 * «FAQ & Presse» (14.09.2026): Warum es die Plattform braucht, wie sie
 * funktioniert, und Material für Medien — auf einer Seite.
 *
 * Aufbau nach Lese-Forschung: kurz, das Warum zuerst, eine Idee pro Absatz,
 * Themen optisch stärker als Fragen, alles offen statt Akkordeon (die Seite ist
 * kurz und ihr Inhalt für die meisten relevant), Sprungliste oben. Das
 * Pressekit schlicht und kopierfreundlich. Jede Zahl trägt eine Quelle.
 *
 * Statisch bis auf den Kopier-Knopf; keine Datenbank.
 */

const SECTIONS = ["why", "idea", "how", "questions", "press"] as const;
const STEPS = [1, 2, 3, 4, 5] as const;
const QUESTIONS = ["binding", "public", "who", "cost"] as const;

const SOURCES = [
  { key: "source1", href: "https://doi.org/10.1073/pnas.2024292118" },
  {
    key: "source2",
    href: "https://www.technologyreview.com/2018/08/21/240284/the-simple-but-ingenious-system-taiwan-uses-to-crowdsource-its-laws/",
  },
] as const;

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/faq">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "faq" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="scroll-mt-6 border-t-2 border-ink pt-5 font-serif text-2xl font-bold leading-tight"
    >
      {children}
    </h2>
  );
}

export default async function FaqPage() {
  const t = await getTranslations("faq");
  const tHeader = await getTranslations("header");

  // Fussnoten-Marker im Fliesstext: «<fn>1</fn>» → hochgestellter Link zur Quelle.
  const footnote = (chunks: ReactNode) => (
    <sup>
      <a
        href={`#quelle-${String(chunks)}`}
        aria-label={t("footnoteLabel", { number: String(chunks) })}
        className="px-0.5 font-mono text-[0.7em] underline underline-offset-2"
      >
        {chunks}
      </a>
    </sup>
  );

  const prose = "mt-4 max-w-prose font-serif leading-relaxed";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-5 sm:py-14">
      <h1 className="font-serif text-3xl font-bold leading-tight">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-prose font-serif text-lg leading-relaxed">
        {t("lead")}
      </p>

      <nav aria-label={t("jumpLabel")} className="mt-7">
        <ul className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[13px]">
          {SECTIONS.map((section) => (
            <li key={section}>
              <a
                href={`#${section}`}
                className="underline underline-offset-4 hover:text-meta"
              >
                {t(`sections.${section}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-labelledby="why" className="mt-12">
        <SectionTitle id="why">{t("why.title")}</SectionTitle>
        <p className={prose}>{t.rich("why.body1", { fn: footnote })}</p>
        <p className={prose}>{t("why.body2")}</p>
      </section>

      <section aria-labelledby="idea" className="mt-12">
        <SectionTitle id="idea">{t("idea.title")}</SectionTitle>
        <p className={prose}>{t("idea.body")}</p>
        <h3 className="mt-6 text-[17px] font-semibold">
          {t("idea.originTitle")}
        </h3>
        <p className="mt-2 max-w-prose font-serif leading-relaxed">
          {t.rich("idea.origin", { fn: footnote })}
        </p>
      </section>

      <section aria-labelledby="how" className="mt-12">
        <SectionTitle id="how">{t("how.title")}</SectionTitle>
        <ol className="mt-5 flex flex-col gap-5">
          {STEPS.map((step) => (
            <li key={step} className="grid grid-cols-[2.25rem_1fr] gap-3">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center border-[1.5px] border-ink font-mono text-sm font-bold"
              >
                {step}
              </span>
              <div>
                <h3 className="text-[17px] font-semibold leading-snug">
                  {t(`how.step${step}Title`)}
                </h3>
                <p className="mt-1 max-w-prose font-serif leading-relaxed">
                  {t(`how.step${step}`)}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            href="/tickets/new"
            className="rounded-[2px] border-[1.5px] border-ink bg-ink px-4 py-2 text-[14.5px] font-semibold text-paper hover:bg-paper hover:text-ink"
          >
            {tHeader("submit")}
          </Link>
          <Link
            href="/"
            className="rounded-[2px] border-[1.5px] border-ink bg-paper px-4 py-2 text-[14.5px] font-semibold text-ink hover:bg-surface"
          >
            {t("how.toBoard")}
          </Link>
        </div>
      </section>

      <section aria-labelledby="questions" className="mt-12">
        <SectionTitle id="questions">{t("questions.title")}</SectionTitle>
        <div className="mt-2">
          {QUESTIONS.map((question) => (
            <div key={question} className="border-b border-line py-4">
              <h3 className="text-[17px] font-semibold leading-snug">
                {t(`questions.${question}Q`)}
              </h3>
              <p className="mt-1 max-w-prose font-serif leading-relaxed">
                {t(`questions.${question}A`)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="press" className="mt-12">
        <SectionTitle id="press">{t("press.title")}</SectionTitle>
        <p className={prose}>{t("press.intro")}</p>

        <CopyText
          testId="press-short"
          label={t("press.shortLabel")}
          text={t("press.short")}
          copyLabel={t("press.copy")}
          copiedLabel={t("press.copied")}
        />
        <CopyText
          testId="press-long"
          label={t("press.longLabel")}
          text={t("press.long")}
          copyLabel={t("press.copy")}
          copiedLabel={t("press.copied")}
        />

        <h3 className="mt-9 text-[17px] font-semibold">
          {t("press.factsTitle")}
        </h3>
        <dl
          data-testid="press-facts"
          className="mt-3 grid grid-cols-1 border-t border-line sm:grid-cols-[12rem_1fr]"
        >
          {(
            [
              ["statusLabel", t("press.status")],
              ["languagesLabel", t("press.languages")],
              ["levelsLabel", t("press.levels")],
              ["aiLabel", t("press.ai")],
              [
                "codeLabel",
                <a
                  key="code"
                  href={SOURCE_CODE_URL}
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >
                  {SOURCE_CODE_URL.replace("https://", "")}
                </a>,
              ],
              ["licenseLabel", "PolyForm Noncommercial 1.0.0"],
              ["adsLabel", t("press.ads")],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="border-line pt-3 font-mono text-xs uppercase tracking-wide text-meta sm:border-b sm:pb-3">
                {t(`press.${label}`)}
              </dt>
              <dd className="border-b border-line pb-3 pt-1 text-[15px] sm:pt-3">
                {value}
              </dd>
            </div>
          ))}
        </dl>

        <h3 className="mt-9 text-[17px] font-semibold">
          {t("press.logoTitle")}
        </h3>
        <div className="mt-3 flex flex-wrap items-center gap-5">
          <SwissCrossLogo label="wiemeinsch.ch" className="h-16 w-16" />
          <div>
            <p className="max-w-prose font-serif text-[15px] leading-relaxed">
              {t("press.logoNote")}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[13px]">
              <a
                href="/presse/wiemeinsch-logo.svg"
                download
                data-testid="press-logo-svg"
                className="underline underline-offset-4"
              >
                {t("press.logoSvg")}
              </a>
              <a
                href="/presse/wiemeinsch-logo-1024.png"
                download
                data-testid="press-logo-png"
                className="underline underline-offset-4"
              >
                {t("press.logoPng")}
              </a>
            </div>
          </div>
        </div>

        <h3 className="mt-9 text-[17px] font-semibold">
          {t("press.contactTitle")}
        </h3>
        <p className="mt-2 font-serif leading-relaxed">
          <a
            href={`mailto:${CONTACT.email}`}
            className="underline underline-offset-4"
          >
            {CONTACT.email}
          </a>
        </p>
      </section>

      <section aria-labelledby="sources" className="mt-14">
        <h2
          id="sources"
          className="font-mono text-xs font-bold uppercase tracking-wide text-meta"
        >
          {t("sourcesTitle")}
        </h2>
        <ol className="mt-3 flex flex-col gap-2 text-[13px] leading-relaxed text-meta">
          {SOURCES.map((source, index) => (
            <li
              key={source.key}
              id={`quelle-${index + 1}`}
              className="grid scroll-mt-6 grid-cols-[1.5rem_1fr]"
            >
              <span className="font-mono">{index + 1}</span>
              <span>
                {t(source.key)}{" "}
                <a
                  href={source.href}
                  rel="noopener noreferrer"
                  className="break-all underline underline-offset-2"
                >
                  {source.href.replace("https://", "").replace(/\/$/, "")}
                </a>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
