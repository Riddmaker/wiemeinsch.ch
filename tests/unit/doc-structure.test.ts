import { describe, expect, it } from "vitest";
import {
  translationIssues,
  hasTranslationIssues,
} from "@/lib/validation/translation-check";
import { ticketTranslationVersionSchema } from "@/lib/validation/ticket";
import {
  constrainedDocSchema,
  DOC_MAX_EMPTY_PARAGRAPHS,
  DOC_MAX_LIST_DEPTH,
} from "@/lib/validation/tiptap";

/** Review 25.09.2026: Strukturgrenzen und Übersetzungsprüfung. */

const text = (value: string) => ({ type: "text" as const, text: value });
const paragraph = (value?: string) =>
  value === undefined
    ? { type: "paragraph" as const }
    : { type: "paragraph" as const, content: [text(value)] };

function nestedList(depth: number): unknown {
  let node: unknown = {
    type: "bulletList",
    content: [{ type: "listItem", content: [paragraph("tief")] }],
  };
  for (let i = 1; i < depth; i += 1) {
    node = {
      type: "bulletList",
      content: [{ type: "listItem", content: [paragraph("x"), node] }],
    };
  }
  return node;
}

describe("constrainedDocSchema — Strukturgrenzen", () => {
  it("akzeptiert normale Texte mit Listen bis zur erlaubten Tiefe", () => {
    const doc = {
      type: "doc",
      content: [paragraph("Einleitung"), nestedList(DOC_MAX_LIST_DEPTH)],
    };
    expect(constrainedDocSchema.safeParse(doc).success).toBe(true);
  });

  it("lehnt zu tief verschachtelte Listen ab", () => {
    const doc = { type: "doc", content: [nestedList(DOC_MAX_LIST_DEPTH + 1)] };
    const parsed = constrainedDocSchema.safeParse(doc);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("too_complex");
  });

  it("lehnt eine Flut leerer Absätze ab", () => {
    const doc = {
      type: "doc",
      content: [
        paragraph("x".repeat(250)),
        ...Array.from({ length: DOC_MAX_EMPTY_PARAGRAPHS + 1 }, () =>
          paragraph(),
        ),
      ],
    };
    expect(constrainedDocSchema.safeParse(doc).success).toBe(false);
  });
});

describe("translationIssues", () => {
  const long = { type: "doc", content: [paragraph("y".repeat(250))] };

  it("nennt Sprache und Feld der verletzten Grenze", () => {
    const issues = translationIssues(ticketTranslationVersionSchema, {
      fr: { title: "x".repeat(81), problem: long, solution: long },
      it: {
        title: "Titolo",
        problem: { type: "doc", content: [paragraph("troppo corto")] },
        solution: long,
      },
    });
    expect(issues).toEqual({
      fr: { title: "max_80" },
      it: { problem: "min_200" },
    });
    expect(hasTranslationIssues(issues)).toBe(true);
  });

  it("gültige Fassungen ergeben keinen Befund", () => {
    const issues = translationIssues(ticketTranslationVersionSchema, {
      fr: { title: "Titre", problem: long, solution: long },
    });
    expect(hasTranslationIssues(issues)).toBe(false);
  });
});
