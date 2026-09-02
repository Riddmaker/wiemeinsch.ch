import { describe, expect, it } from "vitest";
import {
  hashtagSchema,
  hashtagsSchema,
  problemSchema,
  titleSchema,
} from "@/lib/validation/content";
import {
  constrainedDocSchema,
  graphemeLength,
  plainText,
  plainTextLength,
} from "@/lib/validation/tiptap";

const doc = (...blocks: unknown[]) => ({ type: "doc", content: blocks });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: { type: string }[]) => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});
const docWithChars = (n: number) => doc(p(text("a".repeat(n))));

describe("Grenzwerte Problem/Lösung 200–3000 (T5)", () => {
  it("199 → Fehler, 200 → ok, 3000 → ok, 3001 → Fehler", () => {
    expect(problemSchema.safeParse(docWithChars(199)).success).toBe(false);
    expect(problemSchema.safeParse(docWithChars(200)).success).toBe(true);
    expect(problemSchema.safeParse(docWithChars(3000)).success).toBe(true);
    expect(problemSchema.safeParse(docWithChars(3001)).success).toBe(false);
  });
});

describe("titleSchema (max 80 Grapheme)", () => {
  it("80 ok, 81 Fehler, leer Fehler", () => {
    expect(titleSchema.safeParse("t".repeat(80)).success).toBe(true);
    expect(titleSchema.safeParse("t".repeat(81)).success).toBe(false);
    expect(titleSchema.safeParse("   ").success).toBe(false);
  });
});

describe("plainTextLength (nur sichtbarer Text, Grapheme)", () => {
  it("ignoriert Markup (bold/italic)", () => {
    const d = doc(
      p(
        text("fett", [{ type: "bold" }]),
        text(" und "),
        text("kursiv", [{ type: "italic" }]),
      ),
    );
    expect(plainTextLength(d)).toBe("fett und kursiv".length);
  });

  it("zählt verschachtelte Bullet-Lists korrekt", () => {
    const d = doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            p(text("eins")),
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [p(text("zwei"))] }],
            },
          ],
        },
      ],
    });
    expect(plainTextLength(d)).toBe(8);
    expect(plainText(d)).toBe("eins\nzwei");
  });

  it("zählt Umlaute und Emoji als je 1 Graphem", () => {
    expect(graphemeLength("über")).toBe(4);
    expect(graphemeLength("👨‍👩‍👧‍👦")).toBe(1);
    expect(plainTextLength(doc(p(text("grüezi 👨‍👩‍👧‍👦"))))).toBe(8);
  });
});

describe("Hashtags (max 5 × 30, normalisiert)", () => {
  it("normalisiert lowercase und entfernt führendes #", () => {
    expect(hashtagSchema.parse("#Migration")).toBe("migration");
  });

  it("6. Hashtag → Fehler", () => {
    expect(
      hashtagsSchema.safeParse(["a", "b", "c", "d", "e", "f"]).success,
    ).toBe(false);
    expect(hashtagsSchema.safeParse(["a", "b", "c", "d", "e"]).success).toBe(
      true,
    );
  });

  it("31-Zeichen-Hashtag → Fehler", () => {
    expect(hashtagSchema.safeParse("x".repeat(31)).success).toBe(false);
    expect(hashtagSchema.safeParse("x".repeat(30)).success).toBe(true);
  });

  it("Duplikate (nach Normalisierung) → Fehler", () => {
    expect(hashtagsSchema.safeParse(["#Umwelt", "umwelt"]).success).toBe(false);
  });

  it("Leerzeichen/Sonderzeichen → Fehler", () => {
    expect(hashtagSchema.safeParse("zwei worte").success).toBe(false);
  });
});

describe("constrainedDocSchema (Server-Bypass-Schutz)", () => {
  it("lehnt Headings ab", () => {
    const d = doc({
      type: "heading",
      attrs: { level: 1 },
      content: [text("H1")],
    });
    expect(constrainedDocSchema.safeParse(d).success).toBe(false);
  });

  it("lehnt unbekannte Marks (z.B. textStyle/Farbe) ab", () => {
    const d = doc(p(text("bunt", [{ type: "textStyle" }])));
    expect(constrainedDocSchema.safeParse(d).success).toBe(false);
  });

  it("lehnt unbekannte Zusatz-Attribute ab (strict)", () => {
    const d = doc({
      type: "paragraph",
      attrs: { textAlign: "right" },
      content: [text("x")],
    });
    expect(constrainedDocSchema.safeParse(d).success).toBe(false);
  });

  it("akzeptiert das erlaubte Vokabular", () => {
    const d = doc(p(text("normal "), text("fett", [{ type: "bold" }])), {
      type: "bulletList",
      content: [{ type: "listItem", content: [p(text("punkt"))] }],
    });
    expect(constrainedDocSchema.safeParse(d).success).toBe(true);
  });
});
