"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { HASHTAG_MAX_COUNT, HASHTAG_MAX_LENGTH } from "@/lib/validation/limits";

/**
 * Hashtag-Eingabe mit Autocomplete bestehender Tags (P7.1). Tags werden wie
 * in hashtagSchema normalisiert (lowercase, ohne führendes "#"); die
 * verbindliche Validierung bleibt serverseitig.
 */

function normalize(raw: string): string {
  return raw.trim().replace(/^#/, "").toLowerCase();
}
export function HashtagInput({
  tags,
  onChange,
  error,
  label,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  error?: string;
  /**
   * Abweichende Feldbeschriftung. Der Änderungsantrag nutzt das: Dort ist
   * jedes Feld freiwillig, ein «(optional)» im Label wäre irreführend.
   */
  label?: string;
}) {
  const t = useTranslations("ticketNew");
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const addTag = (raw: string) => {
    const tag = normalize(raw);
    if (
      tag.length === 0 ||
      tag.length > HASHTAG_MAX_LENGTH ||
      tags.includes(tag) ||
      tags.length >= HASHTAG_MAX_COUNT
    ) {
      return;
    }
    onChange([...tags, tag]);
    setInput("");
    setSuggestions([]);
  };

  // Autocomplete: debounced gegen /api/hashtags/suggest.
  useEffect(() => {
    const q = normalize(input);
    const tooShort = q.length < 2 || tags.length >= HASHTAG_MAX_COUNT;
    const timer = setTimeout(
      () => {
        if (tooShort) {
          setSuggestions([]);
          return;
        }
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        fetch(`/api/hashtags/suggest?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        })
          .then((res) => (res.ok ? res.json() : { tags: [] }))
          .then((data: { tags?: string[] }) => {
            setSuggestions(
              (data.tags ?? []).filter((tag) => !tags.includes(tag)),
            );
          })
          .catch(() => {
            // Autocomplete ist Komfort — Fehler nie anzeigen.
          });
      },
      tooShort ? 0 : 300,
    );
    return () => clearTimeout(timer);
  }, [input, tags]);

  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="font-mono text-[11.5px] uppercase tracking-wide text-ink"
        id="hashtags-label"
      >
        {label ?? t("hashtagsLabel")}
      </span>
      <div
        className={`flex flex-wrap items-center gap-2 rounded-[2px] border-[1.5px] px-3 py-2 ${
          error ? "border-signal bg-signal-bg" : "border-ink bg-paper"
        }`}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 font-mono text-[12.5px] text-meta"
          >
            #{tag}
            <button
              type="button"
              aria-label={t("hashtagRemove", { tag })}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
              className="px-0.5 font-sans text-ink hover:text-signal"
            >
              ×
            </button>
          </span>
        ))}
        {tags.length < HASHTAG_MAX_COUNT && (
          <input
            type="text"
            value={input}
            aria-labelledby="hashtags-label"
            placeholder={t("hashtagPlaceholder")}
            autoComplete="off"
            maxLength={HASHTAG_MAX_LENGTH + 1}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                addTag(input);
              } else if (
                event.key === "Backspace" &&
                input.length === 0 &&
                tags.length > 0
              ) {
                onChange(tags.slice(0, -1));
              }
            }}
            onBlur={() => addTag(input)}
            className="min-w-[10ch] flex-1 bg-transparent py-0.5 text-[14.5px] outline-none"
          />
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="hashtag-suggestions">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => addTag(tag)}
              className="border border-line px-2 py-0.5 font-mono text-[12.5px] text-meta hover:border-ink hover:text-ink"
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
      {error && <p className="font-mono text-xs text-signal">{error}</p>}
    </div>
  );
}
