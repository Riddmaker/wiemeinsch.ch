import { describe, expect, it } from "vitest";

/**
 * Wortweiser Diff für Änderungsanträge (E13). Der Vergleich muss den Text
 * verlustfrei rekonstruieren — sonst zeigte die Oberfläche einen Inhalt, den
 * so niemand eingereicht hat.
 */
import { diffTags, diffWords, type DiffSegment } from "@/lib/text-diff";

/** Alte Fassung aus dem Diff zurückbauen (same + removed). */
function rebuildBefore(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.type !== "added")
    .map((s) => s.text)
    .join("");
}

/** Neue Fassung aus dem Diff zurückbauen (same + added). */
function rebuildAfter(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.type !== "removed")
    .map((s) => s.text)
    .join("");
}

describe("diffWords", () => {
  it("gleicher Text ergibt genau ein unverändertes Segment", () => {
    expect(diffWords("Tempo 30", "Tempo 30")).toEqual([
      { type: "same", text: "Tempo 30" },
    ]);
  });

  it("leere Texte ergeben kein Segment", () => {
    expect(diffWords("", "")).toEqual([]);
  });

  it("erkennt ein ersetztes Wort und lässt den Rest unangetastet", () => {
    const segments = diffWords(
      "Tempo 30 vor allen Schulen",
      "Tempo 20 vor allen Schulen",
    );
    expect(segments.filter((s) => s.type === "removed")).toEqual([
      { type: "removed", text: "30" },
    ]);
    expect(segments.filter((s) => s.type === "added")).toEqual([
      { type: "added", text: "20" },
    ]);
  });

  it("erkennt reines Hinzufügen am Ende", () => {
    const segments = diffWords("Kosten senken", "Kosten senken und prüfen");
    expect(segments.filter((s) => s.type === "removed")).toHaveLength(0);
    expect(rebuildAfter(segments)).toBe("Kosten senken und prüfen");
  });

  it("erkennt reines Löschen", () => {
    const segments = diffWords("Kosten senken und prüfen", "Kosten senken");
    expect(segments.filter((s) => s.type === "added")).toHaveLength(0);
    expect(rebuildBefore(segments)).toBe("Kosten senken und prüfen");
  });

  it.each([
    ["Wortersatz", "a b c d e", "a b X d e"],
    ["Einschub", "a b c", "a b neu c"],
    ["Löschung", "a b c d", "a d"],
    ["Totalersatz", "alt alt alt", "neu neu neu"],
    ["Absätze", "Zeile eins\nZeile zwei", "Zeile eins\nZeile drei"],
    ["von leer", "", "etwas Neues"],
    ["auf leer", "etwas Altes", ""],
    ["Umlaute", "Grüezi mitenand", "Grüezi zusammen"],
  ])(
    "rekonstruiert beide Fassungen verlustfrei (%s)",
    (_label, before, after) => {
      const segments = diffWords(before, after);
      expect(rebuildBefore(segments)).toBe(before);
      expect(rebuildAfter(segments)).toBe(after);
    },
  );

  it("bleibt bei sehr langen Texten endlich (Grobersetzung statt LCS)", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `a${i}`).join(" ");
    const after = Array.from({ length: 2000 }, (_, i) => `b${i}`).join(" ");
    const started = Date.now();
    const segments = diffWords(before, after);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(rebuildBefore(segments)).toBe(before);
    expect(rebuildAfter(segments)).toBe(after);
  });

  it("fasst gleichartige Segmente zusammen (keine Schnipsel im DOM)", () => {
    const segments = diffWords("a b c d", "a X Y d");
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.type).not.toBe(segments[i - 1]!.type);
    }
  });
});

describe("diffTags", () => {
  it("markiert entfernte, behaltene und neue Tags", () => {
    expect(diffTags(["verkehr", "schule"], ["schule", "velo"])).toEqual([
      { tag: "verkehr", type: "removed" },
      { tag: "schule", type: "same" },
      { tag: "velo", type: "added" },
    ]);
  });

  it("unveränderte Liste ergibt nur «same»", () => {
    expect(
      diffTags(["a", "b"], ["b", "a"]).every((e) => e.type === "same"),
    ).toBe(true);
  });
});
