"use client";

import { Bold } from "@tiptap/extension-bold";
import { BulletList } from "@tiptap/extension-bullet-list";
import { Document } from "@tiptap/extension-document";
import { History } from "@tiptap/extension-history";
import { Italic } from "@tiptap/extension-italic";
import { ListItem } from "@tiptap/extension-list-item";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";
import { plainTextLength } from "@/lib/validation/tiptap";
import { clearDraft, loadDraft, saveDraft } from "./drafts";
import {
  LinterHighlight,
  linterHighlightKey,
  type LinterRange,
} from "./linter-highlight";

/**
 * Constrained Editor (Styleguide Art. 8).
 * NUR Fett, Kursiv, Aufzählung, Absätze — die Schema-Registrierung selbst
 * erzwingt das auch beim Einfügen (unerlaubtes Markup wird verworfen);
 * serverseitig sichert zusätzlich constrainedDocSchema (lib/validation).
 */
export function ConstrainedEditor({
  name,
  label,
  maxChars,
  minChars = 0,
  initialContent,
  onUpdate,
  highlights = [],
}: {
  /** Eindeutiger Key (Formular+Feld) — auch localStorage-Draft-Key. */
  name: string;
  /**
   * Zugängliche Beschriftung des Eingabefelds. ProseMirror setzt auf das
   * contenteditable ein `role="textbox"`; ohne Namen meldet ein Screenreader
   * nur «Textfeld» (WCAG 4.1.2, von axe als `aria-input-field-name` erkannt).
   * Die sichtbare Feldbeschriftung ist kein `<label for>` — sie kann das
   * contenteditable nicht referenzieren — deshalb wird derselbe Text hier
   * übergeben.
   */
  label: string;
  maxChars: number;
  minChars?: number;
  initialContent?: unknown;
  onUpdate?: (doc: unknown, plainLength: number) => void;
  highlights?: LinterRange[];
}) {
  const t = useTranslations("editor");
  const locale = useLocale();
  // Schweizer Zahlenformat (3'000 statt 3.000 — Styleguide Art. 8).
  const chNumber = new Intl.NumberFormat(`${locale}-CH`);

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      BulletList,
      ListItem,
      History,
      LinterHighlight,
    ],
    editorProps: {
      // ProseMirror hängt diese Attribute an das editierbare Element. `role`
      // steht hier mit, weil TipTap seine eigene Vorgabe (`role: "textbox"`)
      // beim erneuten Setzen der Props durch dieses Objekt ersetzt — ohne die
      // Zeile verlöre das Feld seine Rolle (am Browser verifiziert).
      attributes: { role: "textbox", "aria-label": label },
    },
    content: (loadDraft(name) ??
      initialContent ?? { type: "doc", content: [] }) as object,
    immediatelyRender: false,
    onUpdate({ editor: current }) {
      const doc = current.getJSON();
      saveDraft(name, doc);
      onUpdate?.(doc, plainTextLength(doc));
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }
    editor.view.dispatch(
      editor.state.tr.setMeta(linterHighlightKey, highlights),
    );
  }, [editor, highlights]);

  if (!editor) {
    return null;
  }

  const length = plainTextLength(editor.getJSON());
  const overMax = length > maxChars;
  const underMin = minChars > 0 && length < minChars;
  const ratio = Math.min(1, length / maxChars);

  return (
    <div className="max-w-2xl rounded-[2px] border-[1.5px] border-ink bg-paper">
      {/* Toolbar — exakt B / I / Aufzählung (Styleguide Art. 8) */}
      <div
        className="flex gap-1 border-b border-line px-2.5 py-2"
        role="toolbar"
      >
        <button
          type="button"
          aria-pressed={editor.isActive("bold")}
          aria-label={t("bold")}
          title={t("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          className="h-[30px] w-[34px] rounded-[2px] border border-line bg-paper font-mono text-[13px] font-bold aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper"
        >
          B
        </button>
        <button
          type="button"
          aria-pressed={editor.isActive("italic")}
          aria-label={t("italic")}
          title={t("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className="h-[30px] w-[34px] rounded-[2px] border border-line bg-paper font-mono text-[13px] italic aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper"
        >
          I
        </button>
        <button
          type="button"
          aria-pressed={editor.isActive("bulletList")}
          aria-label={t("bulletList")}
          title={t("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className="h-[30px] w-[34px] rounded-[2px] border border-line bg-paper font-mono text-[13px] aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper"
        >
          •—
        </button>
      </div>

      {/* Republik-Style-Textfläche */}
      <EditorContent editor={editor} className="editor-text" />

      {/* Fuss: Fortschrittsbalken + Zähler (Styleguide Art. 8) */}
      <div className="flex items-center gap-3.5 border-t border-line px-4 py-2.5">
        <div className="h-1 flex-1 bg-surface" aria-hidden>
          <div
            className={overMax ? "h-full bg-signal" : "h-full bg-ink"}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
        <span
          data-testid="editor-counter"
          className={
            overMax
              ? "whitespace-nowrap font-mono text-[11.5px] text-signal"
              : underMin
                ? "whitespace-nowrap font-mono text-[11.5px] text-meta"
                : "whitespace-nowrap font-mono text-[11.5px] text-meta"
          }
        >
          {t("counter", {
            count: chNumber.format(length),
            max: chNumber.format(maxChars),
          })}
        </span>
      </div>
    </div>
  );
}

export { clearDraft };
