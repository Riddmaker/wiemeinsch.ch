import {
  constrainedDocSchema,
  type ConstrainedDoc,
} from "@/lib/validation/tiptap";

/**
 * TipTap-JSON ⇄ Markdown-Roundtrip für den Übersetzungs-Flow (P7.5):
 * Der Translation-Service (P6) arbeitet auf Text mit Formatierungs-Markern
 * (**fett**, *kursiv*, "- "-Listen) — Rich-Text-Felder werden vor der
 * Übersetzung serialisiert und die LLM-Antwort danach zurückgeparst.
 *
 * Der Parser ist bewusst fehlertolerant: LLM-Antworten sind untrusted und
 * können Marker verstümmeln — dann bleibt der Text eben unformatiert, der
 * Flow bricht nie. Die geparsten Docs durchlaufen anschliessend ohnehin
 * constrainedDocSchema + Linter (Insecure Output Handling, P6.4).
 */

type MarkType = "bold" | "italic";
type TextNode = { type: "text"; text: string; marks?: { type: MarkType }[] };
type ParagraphNode = { type: "paragraph"; content?: TextNode[] };
type ListItemNode = {
  type: "listItem";
  content: (ParagraphNode | BulletListNode)[];
};
type BulletListNode = { type: "bulletList"; content: ListItemNode[] };
type BlockNode = ParagraphNode | BulletListNode;

const INDENT = "  ";

// ---------------------------------------------------------------------------
// Serialisierung (Doc → Markdown)
// ---------------------------------------------------------------------------

/** Marker-Zeichen im Nutztext entwerten, damit der Roundtrip verlustfrei ist. */
function escapeInline(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\*/g, "\\*");
}

function serializeTextNodes(nodes: TextNode[] | undefined): string {
  if (!nodes) {
    return "";
  }
  return nodes
    .map((node) => {
      const marks = new Set(node.marks?.map((mark) => mark.type));
      const text = escapeInline(node.text);
      if (marks.has("bold") && marks.has("italic")) {
        return `***${text}***`;
      }
      if (marks.has("bold")) {
        return `**${text}**`;
      }
      if (marks.has("italic")) {
        return `*${text}*`;
      }
      return text;
    })
    .join("");
}

function serializeParagraph(node: ParagraphNode): string {
  const line = serializeTextNodes(node.content);
  // Absatz, der wie eine Listenzeile aussieht, entwerten (Roundtrip-Schutz).
  return line.startsWith("- ") ? `\\${line}` : line;
}

function serializeList(node: BulletListNode, depth: number): string[] {
  const lines: string[] = [];
  for (const item of node.content) {
    for (const child of item.content) {
      if (child.type === "bulletList") {
        lines.push(...serializeList(child, depth + 1));
      } else {
        lines.push(
          `${INDENT.repeat(depth)}- ${serializeTextNodes(child.content)}`,
        );
      }
    }
  }
  return lines;
}

/** Serialisiert ein Constrained-Doc als Markdown-artigen Text. */
export function docToMarkdown(doc: ConstrainedDoc): string {
  const blocks: string[] = [];
  for (const node of doc.content ?? []) {
    if (node.type === "paragraph") {
      blocks.push(serializeParagraph(node));
    } else {
      blocks.push(serializeList(node, 0).join("\n"));
    }
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Parsen (Markdown → Doc)
// ---------------------------------------------------------------------------

// Platzhalter aus der Private Use Area — kollisionsfrei mit realem Nutztext.
const ESC_BACKSLASH = String.fromCharCode(0xe000);
const ESC_STAR = String.fromCharCode(0xe001);

/**
 * Inline-Marker parsen. Toleriert unbalancierte Marker: Was nicht als
 * vollständiges Paar erkennbar ist, bleibt Klartext.
 */
function parseInline(raw: string): TextNode[] {
  const nodes: TextNode[] = [];
  // Escapes vor dem Marker-Matching platzhalten, damit "\*" nicht als Marker zählt.
  const guarded = raw
    .replace(/\\\\/g, ESC_BACKSLASH)
    .replace(/\\\*/g, ESC_STAR)
    .replace(/\\-/g, "-");
  const restore = (text: string): string =>
    text.replaceAll(ESC_STAR, "*").replaceAll(ESC_BACKSLASH, "\\");

  const pattern = /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let cursor = 0;
  for (const match of guarded.matchAll(pattern)) {
    if (match.index > cursor) {
      const plain = restore(guarded.slice(cursor, match.index));
      if (plain.length > 0) {
        nodes.push({ type: "text", text: plain });
      }
    }
    if (match[1] !== undefined) {
      nodes.push({
        type: "text",
        text: restore(match[1]),
        marks: [{ type: "bold" }, { type: "italic" }],
      });
    } else if (match[2] !== undefined) {
      nodes.push({
        type: "text",
        text: restore(match[2]),
        marks: [{ type: "bold" }],
      });
    } else if (match[3] !== undefined) {
      nodes.push({
        type: "text",
        text: restore(match[3]),
        marks: [{ type: "italic" }],
      });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < guarded.length) {
    const plain = restore(guarded.slice(cursor));
    if (plain.length > 0) {
      nodes.push({ type: "text", text: plain });
    }
  }
  return nodes;
}

type ListLine = { depth: number; text: string };

function buildList(lines: ListLine[], depth: number): BulletListNode {
  const list: BulletListNode = { type: "bulletList", content: [] };
  while (lines.length > 0) {
    const line = lines[0]!;
    if (line.depth < depth) {
      break;
    }
    if (line.depth > depth) {
      // Verschachtelte Liste gehört zum zuletzt begonnenen Item.
      const nested = buildList(lines, line.depth);
      const parent = list.content[list.content.length - 1];
      if (parent) {
        parent.content.push(nested);
      } else {
        // Degenerierter Einstieg (Liste beginnt eingerückt): Item erzeugen.
        list.content.push({ type: "listItem", content: [nested] });
      }
      continue;
    }
    lines.shift();
    const content = parseInline(line.text);
    list.content.push({
      type: "listItem",
      content: [
        { type: "paragraph", ...(content.length > 0 ? { content } : {}) },
      ],
    });
  }
  return list;
}

/**
 * Parst Markdown-artigen Text zurück in ein Constrained-Doc.
 * Wirft nie — im Zweifel wird Text als schlichter Absatz übernommen.
 */
export function markdownToDoc(text: string): ConstrainedDoc {
  const blocks: BlockNode[] = [];
  const pendingList: ListLine[] = [];

  const flushList = () => {
    if (pendingList.length === 0) {
      return;
    }
    const minDepth = Math.min(...pendingList.map((line) => line.depth));
    const lines = [...pendingList];
    pendingList.length = 0;
    while (lines.length > 0) {
      blocks.push(buildList(lines, minDepth));
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const listMatch = /^(\s*)-\s+(.*)$/.exec(rawLine);
    if (listMatch) {
      pendingList.push({
        depth: Math.floor(listMatch[1]!.length / INDENT.length),
        text: listMatch[2]!,
      });
      continue;
    }
    flushList();
    if (rawLine.trim().length === 0) {
      continue;
    }
    // Entwerteten Listen-Anfang ("\- ") wieder freigeben.
    const lineText = rawLine.trim().replace(/^\\(?=- )/, "");
    const content = parseInline(lineText);
    blocks.push({
      type: "paragraph",
      ...(content.length > 0 ? { content } : {}),
    });
  }
  flushList();

  const doc = { type: "doc" as const, content: blocks };
  // Selbstkontrolle gegen das strikte Schema — bei Überraschung Klartext-Fallback.
  const checked = constrainedDocSchema.safeParse(doc);
  if (checked.success) {
    return checked.data;
  }
  return {
    type: "doc",
    content: text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => ({
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: line.trim() }],
      })),
  };
}
