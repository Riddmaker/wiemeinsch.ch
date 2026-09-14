import { unstable_isUnrecognizedActionError } from "next/navigation";

/**
 * Server-Action-Aufrufe aus Client-Komponenten, die nicht still scheitern
 * (14.09.2026, vor dem ersten Deploy).
 *
 * Befund: Die Formulare werten nur das Rückgabeobjekt `{ ok, error }` aus.
 * WIRFT der Aufruf, passiert sichtbar nichts — der Knopf «tut nichts». Der
 * häufigste Fall kommt nach jedem Deploy: Ein offener Tab kennt die Action-IDs
 * des alten Builds, der Server antwortet «Failed to find Server Action», und
 * Next wirft `UnrecognizedActionError`. Die Next-Doku empfiehlt dafür genau
 * das: den Fehler als Neuladen-Weg anzeigen statt als harten Fehler
 * (docs/01-app/02-guides/server-actions.md → Deployment considerations).
 *
 * Statt in jedem Formular eine eigene Meldung zu bauen, meldet dieser Helfer
 * den Fehler per Fenster-Event; `ActionFailureNotice` im Layout zeigt ihn an.
 * Das Formular erhält `null` und bricht ab — sein `finally` räumt wie bisher
 * den Ladezustand auf.
 */

export const ACTION_FAILURE_EVENT = "wiemeinsch:action-failure";

/** `stale` = Seite stammt aus einem älteren Build; `failed` = alles andere. */
export type ActionFailureKind = "stale" | "failed";

export function actionFailureKind(error: unknown): ActionFailureKind {
  return unstable_isUnrecognizedActionError(error) ? "stale" : "failed";
}

export async function callAction<T>(
  action: () => Promise<T>,
): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    // Kein `error.message` weiterreichen: In Produktion ist er generisch, und
    // die Meldung im UI soll ohnehin nur den nächsten Schritt nennen.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent<ActionFailureKind>(ACTION_FAILURE_EVENT, {
          detail: actionFailureKind(error),
        }),
      );
    }
    return null;
  }
}
