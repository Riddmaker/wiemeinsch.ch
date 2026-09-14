import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "@/lib/tiptap-markdown";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";
import { constrainedDocSchema, plainText } from "@/lib/validation/tiptap";

/**
 * TipTap-JSON ⇄ Markdown-Roundtrip (P7.5): Serialisierung fürs Übersetzen,
 * fehlertolerantes Zurückparsen der (untrusted) LLM-Antwort.
 */

const doc = (content: ConstrainedDoc["content"]): ConstrainedDoc => ({
  type: "doc",
  content,
});

describe("docToMarkdown / markdownToDoc (P7.5)", () => {
  it("Roundtrip: Absätze mit Fett/Kursiv/beidem bleiben identisch", () => {
    const original = doc([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Sachlicher Auftakt mit " },
          { type: "text", text: "Gewicht", marks: [{ type: "bold" }] },
          { type: "text", text: " und " },
          { type: "text", text: "Betonung", marks: [{ type: "italic" }] },
          { type: "text", text: "." },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Beides zugleich",
            marks: [{ type: "bold" }, { type: "italic" }],
          },
        ],
      },
    ]);
    const markdown = docToMarkdown(original);
    expect(markdown).toBe(
      "Sachlicher Auftakt mit **Gewicht** und *Betonung*.\n\n***Beides zugleich***",
    );
    expect(markdownToDoc(markdown)).toEqual(original);
  });

  it("Roundtrip: verschachtelte Aufzählungen behalten ihre Struktur", () => {
    const original = doc([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Punkt eins" }],
              },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "Unterpunkt" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Punkt zwei" }],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Absatz danach" }],
      },
    ]);
    const markdown = docToMarkdown(original);
    expect(markdown).toBe(
      "- Punkt eins\n  - Unterpunkt\n- Punkt zwei\n\nAbsatz danach",
    );
    expect(markdownToDoc(markdown)).toEqual(original);
  });

  it("Roundtrip: Stern/Backslash im Nutztext und '- '-Absatzanfang überleben", () => {
    const original = doc([
      {
        type: "paragraph",
        content: [{ type: "text", text: "Formel: 3 * 4 = 12 (Pfad C:\\tmp)" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "- kein Listenpunkt, ein Absatz" }],
      },
    ]);
    const roundtripped = markdownToDoc(docToMarkdown(original));
    expect(roundtripped).toEqual(original);
  });

  it("unbalancierte LLM-Marker crashen nicht und bleiben Klartext", () => {
    const parsed = markdownToDoc("Ein **kaputter Marker ohne Ende");
    expect(constrainedDocSchema.safeParse(parsed).success).toBe(true);
    expect(plainText(parsed)).toBe("Ein **kaputter Marker ohne Ende");
  });

  it("typische LLM-Antwort mit Liste wird korrekt geparst", () => {
    const parsed = markdownToDoc(
      "Deux **mesures** concrètes:\n- première mesure\n- seconde mesure",
    );
    expect(parsed.content).toHaveLength(2);
    expect(parsed.content?.[0]?.type).toBe("paragraph");
    expect(parsed.content?.[1]?.type).toBe("bulletList");
    expect(plainText(parsed)).toBe(
      "Deux mesures concrètes:\npremière mesure\nseconde mesure",
    );
  });

  it("leerer Text ergibt ein leeres, schema-konformes Doc", () => {
    const parsed = markdownToDoc("");
    expect(constrainedDocSchema.safeParse(parsed).success).toBe(true);
    expect(plainText(parsed)).toBe("");
  });
});
