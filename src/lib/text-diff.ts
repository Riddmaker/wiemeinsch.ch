/**
 * Wortweiser Textvergleich für Änderungsanträge (E13, 04.09.2026).
 *
 * Vorher standen alte und neue Fassung als zwei Blöcke nebeneinander — der
 * Autor musste den Unterschied selbst suchen. Jetzt zeigt EIN Block, was
 * entfernt und was hinzugefügt wurde.
 *
 * Verglichen wird der reine Text (Markup geht im Diff verloren, siehe
 * DiffView) auf Wortebene: Zeichenweise wäre das Ergebnis unlesbar,
 * absatzweise zu grob für eine geänderte Zahl im Satz.
 */

export type DiffSegment = {
  type: "same" | "removed" | "added";
  text: string;
};

/**
 * Obergrenze für den LCS-Vergleich. Darüber wird der Block als Ganzes
 * ersetzt gezeigt: Der Algorithmus ist O(n·m), und bei sehr langen,
 * vollständig umgeschriebenen Texten wäre ein wortweiser Diff ohnehin
 * nicht mehr lesbar.
 */
const MAX_TOKENS = 1200;

/** Wörter und Trennzeichen getrennt behalten, damit der Text rekonstruierbar bleibt. */
function tokenize(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(\s+)/).filter((t) => t !== "");
}

function pushSegment(
  segments: DiffSegment[],
  type: DiffSegment["type"],
  text: string,
): void {
  if (text.length === 0) {
    return;
  }
  const last = segments[segments.length - 1];
  if (last && last.type === type) {
    last.text += text;
    return;
  }
  segments.push({ type, text });
}

/** Längste gemeinsame Teilfolge, klassische Tabelle. */
function lcsTable(a: string[], b: string[]): Int32Array {
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  return table;
}

/**
 * Vergleicht zwei Texte wortweise.
 *
 * Gemeinsamer Anfang und gemeinsames Ende werden vorab abgeschnitten — bei
 * einer geänderten Zahl in einem langen Absatz bleibt so ein winziger Rest
 * für den teuren Teil übrig.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  if (before === after) {
    return before.length > 0 ? [{ type: "same", text: before }] : [];
  }

  const a = tokenize(before);
  const b = tokenize(after);
  const segments: DiffSegment[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  pushSegment(segments, "same", a.slice(0, start).join(""));

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length > MAX_TOKENS || midB.length > MAX_TOKENS) {
    pushSegment(segments, "removed", midA.join(""));
    pushSegment(segments, "added", midB.join(""));
  } else {
    const width = midB.length + 1;
    const table = lcsTable(midA, midB);
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        pushSegment(segments, "same", midA[i]!);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        pushSegment(segments, "removed", midA[i]!);
        i += 1;
      } else {
        pushSegment(segments, "added", midB[j]!);
        j += 1;
      }
    }
    pushSegment(segments, "removed", midA.slice(i).join(""));
    pushSegment(segments, "added", midB.slice(j).join(""));
  }

  pushSegment(segments, "same", a.slice(endA).join(""));
  return segments;
}

/** Vergleich zweier Hashtag-Listen — Reihenfolge spielt keine Rolle. */
export function diffTags(
  before: string[],
  after: string[],
): { tag: string; type: DiffSegment["type"] }[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const result: { tag: string; type: DiffSegment["type"] }[] = [];
  for (const tag of before) {
    result.push({ tag, type: afterSet.has(tag) ? "same" : "removed" });
  }
  for (const tag of after) {
    if (!beforeSet.has(tag)) {
      result.push({ tag, type: "added" });
    }
  }
  return result;
}
