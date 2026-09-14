"use client";

import { useEffect, useState } from "react";

/**
 * Kurztext für Medien mit Kopier-Knopf (Presse-Seite).
 *
 * Der Text bleibt normal markierbar: Ohne Zwischenablage-Zugriff (alter
 * Browser, verweigerte Berechtigung) kopiert man ihn eben von Hand.
 */
export function CopyText({
  label,
  text,
  copyLabel,
  copiedLabel,
  testId,
}: {
  label: string;
  text: string;
  copyLabel: string;
  copiedLabel: string;
  testId: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Kein Zugriff auf die Zwischenablage — der Text ist markierbar.
    }
  };

  return (
    <figure data-testid={testId} className="mt-5">
      <figcaption className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-xs font-bold uppercase tracking-wide text-meta">
          {label}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          data-testid={`${testId}-copy`}
          className="rounded-[2px] border border-ink bg-paper px-2.5 py-1 font-mono text-[12px] font-bold text-ink hover:bg-ink hover:text-paper"
        >
          <span aria-live="polite">{copied ? copiedLabel : copyLabel}</span>
        </button>
      </figcaption>
      <blockquote className="mt-2 border-l-4 border-ink bg-surface px-4 py-3 font-serif leading-relaxed">
        {text}
      </blockquote>
    </figure>
  );
}
