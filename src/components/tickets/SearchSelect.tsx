"use client";

import { useId, useMemo, useState } from "react";

export type SearchOption = { id: number; label: string };

const MAX_VISIBLE = 50;

/**
 * Durchsuchbares Dropdown (P7.1) für Kantone/Gemeinden: Eingabefeld filtert
 * die Optionsliste clientseitig (Stammdaten sind statisch, kein Request nötig).
 * Tastatur: Pfeile + Enter + Escape; ARIA-Combobox-Muster.
 */
export function SearchSelect({
  label,
  options,
  value,
  onSelect,
  noResultsText,
  error,
}: {
  label: string;
  options: SearchOption[];
  value: number | null;
  onSelect: (id: number | null) => void;
  noResultsText: string;
  error?: string;
}) {
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const selectedLabel = useMemo(
    () => options.find((option) => option.id === value)?.label ?? "",
    [options, value],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return options.slice(0, MAX_VISIBLE);
    }
    return options
      .filter((option) => option.label.toLowerCase().includes(needle))
      .slice(0, MAX_VISIBLE);
  }, [options, query]);

  const select = (option: SearchOption) => {
    onSelect(option.id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[11.5px] uppercase tracking-wide text-ink">
          {label}
        </span>
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            open && filtered[activeIndex]
              ? `${listboxId}-${filtered[activeIndex].id}`
              : undefined
          }
          aria-invalid={Boolean(error)}
          autoComplete="off"
          value={open ? query : selectedLabel}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
            onSelect(null);
          }}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) =>
                Math.min(index + 1, filtered.length - 1),
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              if (open && filtered[activeIndex]) {
                event.preventDefault();
                select(filtered[activeIndex]);
              }
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          className={`rounded-[2px] border-[1.5px] px-3 py-2.5 text-[15px] ${
            error
              ? "border-signal bg-signal-bg"
              : "border-ink bg-paper focus:border-ink"
          }`}
        />
      </label>
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto border border-ink bg-paper shadow-sm"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 font-mono text-xs text-meta">
              {noResultsText}
            </li>
          )}
          {filtered.map((option, index) => (
            <li
              key={option.id}
              id={`${listboxId}-${option.id}`}
              role="option"
              aria-selected={option.id === value}
              className={`cursor-pointer px-3 py-2 text-[14.5px] ${
                index === activeIndex ? "bg-ink text-paper" : "hover:bg-surface"
              }`}
              onMouseDown={(event) => {
                // mousedown statt click: läuft vor dem Blur des Inputs.
                event.preventDefault();
                select(option);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1.5 font-mono text-xs text-signal">{error}</p>}
    </div>
  );
}
