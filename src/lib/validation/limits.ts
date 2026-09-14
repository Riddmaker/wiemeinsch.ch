/**
 * Zeichenlimiten.
 * Single Source of Truth — Client-Formulare UND Server Actions importieren
 * ausschliesslich von hier (keine doppelt gepflegten Limiten).
 *
 * Zählweise: Limiten gelten für den reinen Text ohne Markup, gemessen in
 * Unicode-Graphemen (wahrgenommene Zeichen; Emoji/Umlaute zählen als 1) —
 * identisch im Client-Counter und serverseitig (plainTextLength).
 */
export const TITLE_MAX = 80;
export const PROBLEM_MIN = 200;
export const PROBLEM_MAX = 3000;
export const SOLUTION_MIN = 200;
export const SOLUTION_MAX = 3000;
export const FUNDING_MAX = 1500;
export const STATEMENT_MIN = 50;
export const STATEMENT_MAX = 500;
export const HASHTAG_MAX_COUNT = 5;
export const HASHTAG_MAX_LENGTH = 30;
