"use client";

import { useState } from "react";
import { ConstrainedEditor } from "@/components/editor/ConstrainedEditor";
import type { LinterRange } from "@/components/editor/linter-highlight";
import { PROBLEM_MAX, PROBLEM_MIN } from "@/lib/validation/limits";
import { plainText } from "@/lib/validation/tiptap";

// Dev-only-Spielwiese für Editor-Selbsttests (T5); in Prod per notFound gesperrt.
// Kein User-UI — Beschriftungen bewusst technisch/einsprachig.
export function EditorPlayground() {
  const [doc, setDoc] = useState<unknown>(null);
  const [length, setLength] = useState(0);
  const [highlights, setHighlights] = useState<LinterRange[]>([]);

  const highlightFirstSentence = () => {
    const text = plainText(doc);
    const end = text.search(/[.!?](\s|$)/);
    setHighlights(
      end > 0 ? [{ start: 0, end: end + 1, reason: "POLEMIK" }] : [],
    );
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-mono text-lg font-bold">dev/editor</h1>
      <div className="mt-6">
        <ConstrainedEditor
          name="dev-editor"
          label="Dev-Editor"
          minChars={PROBLEM_MIN}
          maxChars={PROBLEM_MAX}
          onUpdate={(d, len) => {
            setDoc(d);
            setLength(len);
          }}
          highlights={highlights}
        />
      </div>
      <div className="mt-4 flex gap-3 font-mono text-xs">
        <button
          type="button"
          data-testid="dev-highlight"
          onClick={highlightFirstSentence}
          className="border border-line px-2 py-1"
        >
          highlight satz 1
        </button>
        <button
          type="button"
          data-testid="dev-clear-highlight"
          onClick={() => setHighlights([])}
          className="border border-line px-2 py-1"
        >
          clear
        </button>
        <span data-testid="dev-length">len={length}</span>
      </div>
      <pre
        data-testid="dev-json"
        className="mt-4 overflow-x-auto bg-surface p-3 font-mono text-[10px]"
      >
        {JSON.stringify(doc)}
      </pre>
    </div>
  );
}
