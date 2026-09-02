"use client";

import "./globals.css";

/**
 * Letzte Auffangebene (P13.6): greift nur, wenn das Root-Layout selbst
 * fehlschlägt. Dann existiert weder der `NextIntlClientProvider` noch eine
 * bekannte Locale — deshalb ist dies die EINZIGE Stelle mit fest verdrahteten
 * UI-Texten (bewusste Ausnahme zu Betriebsregel 8).
 * Alle drei Landessprachen stehen nebeneinander, weil die Sprache des
 * Besuchers hier nicht mehr bestimmbar ist.
 *
 * Wie in `[locale]/error.tsx` wird der `error`-Prop NICHT gerendert: keine
 * Meldung, kein Stack, kein Pfad (T13 — kein Information Leak).
 */
export default function GlobalError() {
  return (
    <html lang="de">
      <body className="bg-paper text-ink">
        <div className="mx-auto max-w-2xl px-4 py-16 sm:py-24">
          <h1 className="font-serif text-3xl font-bold leading-tight">
            Es ist ein Fehler aufgetreten
          </h1>
          <p className="mt-4 font-serif leading-relaxed">
            Die Seite konnte nicht geladen werden. Bitte lade sie neu.
          </p>
          <p className="mt-6 font-serif leading-relaxed" lang="fr">
            Une erreur est survenue. Merci de recharger la page.
          </p>
          <p className="mt-2 font-serif leading-relaxed" lang="it">
            Si è verificato un errore. Ricarica la pagina.
          </p>
          <p className="mt-8">
            {/*
              Absichtlich ein natives <a> statt <Link>: An dieser Stelle ist
              der React-Baum der Anwendung kaputt, ein Client-seitiger
              Router-Wechsel würde denselben Fehler erneut auslösen. Nur ein
              vollständiger Seitenaufbau hilft.
            */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="font-mono text-sm underline underline-offset-4"
            >
              wiemeinsch.ch
            </a>
          </p>
        </div>
      </body>
    </html>
  );
}
