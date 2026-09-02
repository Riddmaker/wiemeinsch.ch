import type { ReactNode } from "react";
import { constrainedDocSchema } from "@/lib/validation/tiptap";

/**
 * Sichere Anzeige gespeicherter TipTap-JSON-Inhalte (P7.6): strikte
 * Schema-Validierung + React-Elementbaum — nie dangerouslySetInnerHTML
 * (P7-Stolperstein; OWASP Insecure Output Handling). Unerwartete Struktur
 * wird verworfen statt gerendert.
 */

type ValidDoc = ReturnType<typeof constrainedDocSchema.parse>;
type BlockNode = NonNullable<ValidDoc["content"]>[number];
type TextNode = { text: string; marks?: { type: "bold" | "italic" }[] };

function renderText(node: TextNode, key: number): ReactNode {
  const marks = new Set(node.marks?.map((mark) => mark.type));
  let element: ReactNode = node.text;
  if (marks.has("italic")) {
    element = <em>{element}</em>;
  }
  if (marks.has("bold")) {
    element = <strong>{element}</strong>;
  }
  return <span key={key}>{element}</span>;
}

function renderBlock(node: BlockNode, key: number): ReactNode {
  if (node.type === "paragraph") {
    return (
      <p key={key}>{node.content?.map((child, i) => renderText(child, i))}</p>
    );
  }
  return (
    <ul key={key}>
      {node.content.map((item, i) => (
        <li key={i}>
          {item.content.map((child, j) =>
            child.type === "bulletList" ? (
              renderBlock(child, j)
            ) : (
              <p key={j}>
                {child.content?.map((text, k) => renderText(text, k))}
              </p>
            ),
          )}
        </li>
      ))}
    </ul>
  );
}

export function RichTextView({
  doc,
  className,
}: {
  doc: unknown;
  className?: string;
}) {
  const parsed = constrainedDocSchema.safeParse(doc);
  if (!parsed.success) {
    return null;
  }
  return (
    <div className={className}>
      {parsed.data.content?.map((node, i) => renderBlock(node, i))}
    </div>
  );
}
