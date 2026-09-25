import { z } from "./zod";

/**
 * Strikte Schemas für TipTap-JSON (Constrained Editing, →
 * Text Editor UX). Erlaubt sind AUSSCHLIESSLICH: doc, paragraph, text,
 * bulletList, listItem sowie die Marks bold/italic — alles andere wird
 * serverseitig abgelehnt (Bypass-Schutz: der Server verlässt sich nie auf
 * das Editor-UI). Knotennamen verifiziert gegen @tiptap 3.30.5.
 */

const markSchema = z.strictObject({
  type: z.enum(["bold", "italic"]),
});

const textNodeSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string().min(1),
  marks: z.array(markSchema).optional(),
});

const paragraphSchema = z.strictObject({
  type: z.literal("paragraph"),
  content: z.array(textNodeSchema).optional(),
});

type BulletListInput = {
  type: "bulletList";
  content: ListItemInput[];
};
type ListItemInput = {
  type: "listItem";
  content: (z.input<typeof paragraphSchema> | BulletListInput)[];
};

const bulletListSchema: z.ZodType<BulletListInput> = z.strictObject({
  type: z.literal("bulletList"),
  content: z.array(z.lazy(() => listItemSchema)).min(1),
});

const listItemSchema: z.ZodType<ListItemInput> = z.strictObject({
  type: z.literal("listItem"),
  // Verschachtelte Listen sind erlaubt (Stolperstein P5: plainTextLength).
  content: z
    .array(z.union([paragraphSchema, z.lazy(() => bulletListSchema)]))
    .min(1),
});

/**
 * Strukturgrenzen (Code-Review 25.09.2026). Die Zeichenlimiten zählen nur
 * Text — ein Dokument mit 200 Zeichen und 40'000 leeren Absätzen oder einer
 * hundertfach verschachtelten Liste hätte sie erfüllt (das Server-Action-
 * Limit von 1 MB lässt so etwas zu) und die Detailseite für alle unlesbar
 * gemacht. Die Werte liegen weit über dem, was ein Text von 3'000 Zeichen
 * braucht.
 */
export const DOC_MAX_NODES = 1_500;
export const DOC_MAX_LIST_DEPTH = 4;
export const DOC_MAX_EMPTY_PARAGRAPHS = 100;

type StructureStats = { nodes: number; listDepth: number; empty: number };

/** Iterativ statt rekursiv — auch ein absurd tiefes Dokument sprengt nichts. */
function structureStats(doc: unknown): StructureStats {
  const stats: StructureStats = { nodes: 0, listDepth: 0, empty: 0 };
  const stack: { node: unknown; depth: number }[] = [{ node: doc, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (typeof node !== "object" || node === null) {
      continue;
    }
    stats.nodes += 1;
    const n = node as { type?: unknown; content?: unknown };
    const listDepth = n.type === "bulletList" ? depth + 1 : depth;
    stats.listDepth = Math.max(stats.listDepth, listDepth);
    if (
      n.type === "paragraph" &&
      (!Array.isArray(n.content) || n.content.length === 0)
    ) {
      stats.empty += 1;
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) {
        stack.push({ node: child, depth: listDepth });
      }
    }
  }
  return stats;
}

export const constrainedDocSchema = z
  .strictObject({
    type: z.literal("doc"),
    content: z.array(z.union([paragraphSchema, bulletListSchema])).optional(),
  })
  .superRefine((doc, ctx) => {
    const stats = structureStats(doc);
    if (
      stats.nodes > DOC_MAX_NODES ||
      stats.listDepth > DOC_MAX_LIST_DEPTH ||
      stats.empty > DOC_MAX_EMPTY_PARAGRAPHS
    ) {
      ctx.addIssue({ code: "custom", message: "too_complex" });
    }
  });

export type ConstrainedDoc = z.output<typeof constrainedDocSchema>;

// ---------------------------------------------------------------------------
// Reiner Text & Zählung
// ---------------------------------------------------------------------------

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Anzahl Unicode-Grapheme eines Strings (Emoji, Umlaute etc. = je 1). */
export function graphemeLength(text: string): number {
  let count = 0;
  const segments = graphemeSegmenter.segment(text)[Symbol.iterator]();
  while (!segments.next().done) {
    count++;
  }
  return count;
}

function collectTextNodes(node: unknown, out: string[]): void {
  if (typeof node !== "object" || node === null) {
    return;
  }
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "text" && typeof n.text === "string") {
    out.push(n.text);
  }
  if (Array.isArray(n.content)) {
    for (const child of n.content) {
      collectTextNodes(child, out);
    }
  }
}

function collectParagraphLines(node: unknown, out: string[]): void {
  if (typeof node !== "object" || node === null) {
    return;
  }
  const n = node as { type?: unknown; content?: unknown };
  if (n.type === "paragraph") {
    const texts: string[] = [];
    collectTextNodes(n, texts);
    out.push(texts.join(""));
    return;
  }
  if (Array.isArray(n.content)) {
    for (const child of n.content) {
      collectParagraphLines(child, out);
    }
  }
}

/**
 * Sichtbarer Text eines TipTap-Dokuments: eine Zeile pro Absatz (auch in
 * verschachtelten Listen), mit "\n" verbunden. Die Offsets dieses Strings
 * sind die verbindliche Referenz für Linter-Ranges (P6/P7) und werden von
 * der Editor-Highlight-API identisch interpretiert.
 */
export function plainText(doc: unknown): string {
  const lines: string[] = [];
  collectParagraphLines(doc, lines);
  return lines.join("\n");
}

/**
 * Zeichenzahl des reinen Texts (ohne Markup, ohne Block-Trenner) in
 * Unicode-Graphemen — die verbindliche Zählweise für alle Limiten.
 */
export function plainTextLength(doc: unknown): number {
  const texts: string[] = [];
  collectTextNodes(doc, texts);
  let count = 0;
  for (const text of texts) {
    count += graphemeLength(text);
  }
  return count;
}

/**
 * Enthält das Dokument keinen sichtbaren Text? Ein geleerter Editor liefert
 * einen leeren Absatz, kein fehlendes Feld — das zählt hier als leer.
 */
export function isEmptyDoc(doc: unknown): boolean {
  return plainText(doc).trim().length === 0;
}
