/**
 * Auto-Save-Entwürfe im localStorage.
 * Key pro Formular+Feld; nach erfolgreichem Publish via clearDraft löschen (P7.7).
 * Alle Zugriffe try/catch — localStorage kann fehlen/blockiert sein.
 */
const PREFIX = "wiemeinsch:draft:";

export function saveDraft(key: string, doc: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(doc));
  } catch {
    // Auto-Save ist Komfort — nie den Editor blockieren.
  }
}

export function loadDraft(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // ignorieren
  }
}
