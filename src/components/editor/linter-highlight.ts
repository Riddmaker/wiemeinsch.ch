import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Highlight-API des Editors (P5.5): nimmt Ranges im plainText-Offsetraum
 * (siehe lib/validation/tiptap.ts → plainText: eine Zeile pro Absatz, "\n"
 * getrennt, UTF-16-Codeunits) entgegen und rendert die rote Unterlegung
 * (Styleguide Art. 8, Klasse .linter-mark). Befüllt ab P7 vom Civic-Linter.
 */
export type LinterRange = { start: number; end: number; reason?: string };

export const linterHighlightKey = new PluginKey<DecorationSet>(
  "linterHighlight",
);

function buildDecorations(doc: PmNode, ranges: LinterRange[]): DecorationSet {
  if (ranges.length === 0) {
    return DecorationSet.empty;
  }
  const decorations: Decoration[] = [];
  let offset = 0; // Offset im plainText (inkl. "\n" nach jedem Absatz)

  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph") {
      return true;
    }
    let inner = 0;
    node.forEach((child, childOffset) => {
      if (!child.isText || !child.text) {
        return;
      }
      const textStart = offset + inner;
      const textEnd = textStart + child.text.length;
      for (const range of ranges) {
        const from = Math.max(range.start, textStart);
        const to = Math.min(range.end, textEnd);
        if (from < to) {
          const base = pos + 1 + childOffset;
          decorations.push(
            Decoration.inline(
              base + (from - textStart),
              base + (to - textStart),
              {
                class: "linter-mark",
                ...(range.reason ? { "data-reason": range.reason } : {}),
              },
            ),
          );
        }
      }
      inner += child.text.length;
    });
    offset += inner + 1;
    return false; // Absatz-Kinder sind verarbeitet
  });

  return DecorationSet.create(doc, decorations);
}

export const LinterHighlight = Extension.create({
  name: "linterHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: linterHighlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const ranges = tr.getMeta(linterHighlightKey) as
              LinterRange[] | undefined;
            if (ranges) {
              return buildDecorations(tr.doc, ranges);
            }
            if (tr.docChanged) {
              return old.map(tr.mapping, tr.doc);
            }
            return old;
          },
        },
        props: {
          decorations(state) {
            return linterHighlightKey.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
