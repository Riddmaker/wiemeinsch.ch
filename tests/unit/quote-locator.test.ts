import { describe, expect, it } from "vitest";
import {
  diceSimilarity,
  locateQuote,
  splitSentences,
} from "@/services/quote-locator";

describe("diceSimilarity", () => {
  it("ist 1 für identische Strings und 0 für disjunkte", () => {
    expect(diceSimilarity("polemik", "polemik")).toBe(1);
    expect(diceSimilarity("abcd", "wxyz")).toBe(0);
  });

  it("ist hoch für fast identische Sätze", () => {
    const a = "der bundesrat verschläft das problem";
    const b = "der bundesrat verschläft das problem!";
    expect(diceSimilarity(a, b)).toBeGreaterThan(0.9);
  });
});

describe("splitSentences", () => {
  it("liefert Spans, die exakt auf den Satzgrenzen liegen", () => {
    const text = "Erster Satz. Zweiter Satz! Dritter Satz";
    const spans = splitSentences(text);
    expect(spans.map(({ from, to }) => text.slice(from, to))).toEqual([
      "Erster Satz.",
      "Zweiter Satz!",
      "Dritter Satz",
    ]);
  });

  it("behandelt Zeilenumbrüche als Grenze (Listen ohne Satzzeichen)", () => {
    const text = "- Punkt eins\n- Punkt zwei";
    const spans = splitSentences(text);
    expect(spans.map(({ from, to }) => text.slice(from, to))).toEqual([
      "- Punkt eins",
      "- Punkt zwei",
    ]);
  });
});

describe("locateQuote", () => {
  const text =
    "Die Kita-Finanzierung ist ungelöst. Der Bundesrat verschläft das Problem und schiebt die Verantwortung feige ab. Wir fordern eine Übergangslösung.";

  it("findet ein exaktes Zitat", () => {
    const quote =
      "Der Bundesrat verschläft das Problem und schiebt die Verantwortung feige ab.";
    const range = locateQuote(text, quote);
    expect(range.method).toBe("exact");
    expect(text.slice(range.from, range.to)).toBe(quote);
  });

  it("findet ein Zitat trotz abweichender Anführungszeichen und Whitespace", () => {
    const source = 'Er sagte: „Das ist ein   Skandal" und ging.';
    const quote = "Er sagte: 'Das ist ein Skandal' und ging.";
    const range = locateQuote(source, quote);
    expect(range.method).toBe("normalized");
    expect(range.from).toBe(0);
    expect(source.slice(range.from, range.to)).toContain("Skandal");
  });

  it("fällt auf Satz-Ebene zurück, wenn das LLM leicht paraphrasiert", () => {
    const quote =
      "Der Bundesrat verschläft dieses Problem und schiebt die Verantwortung ab";
    const range = locateQuote(text, quote);
    expect(range.method).toBe("sentence");
    expect(text.slice(range.from, range.to)).toBe(
      "Der Bundesrat verschläft das Problem und schiebt die Verantwortung feige ab.",
    );
  });

  it("liefert als letzten Fallback den ganzen Text (Range immer im Text)", () => {
    const range = locateQuote(text, "völlig anderes zeug ohne bezug");
    expect(range.method).toBe("fallback");
    expect(range.from).toBe(0);
    expect(range.to).toBe(text.length);
  });

  it("liefert nie Offsets ausserhalb des Textes", () => {
    for (const quote of ["", "x", text, `${text} und mehr`]) {
      const range = locateQuote(text, quote);
      expect(range.from).toBeGreaterThanOrEqual(0);
      expect(range.to).toBeLessThanOrEqual(text.length);
      expect(range.from).toBeLessThanOrEqual(range.to);
    }
  });
});
