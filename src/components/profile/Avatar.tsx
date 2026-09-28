import { AVATAR_BACKGROUND, identicon } from "@/lib/identicon";

/**
 * Profilbild (27.09.2026): Identicon als Inline-SVG — keine Bilddatei, keine
 * externe Anfrage, nichts für die CSP. Ohne Hooks, also in Server- und
 * Client-Komponenten nutzbar.
 *
 * Steht immer neben dem @handle, der der eigentliche Name ist; deshalb
 * standardmässig dekorativ (`aria-hidden`). Wer das Bild allein zeigt, gibt
 * ein `label`.
 */
export function Avatar({
  seed,
  className = "h-5 w-5",
  label,
}: {
  seed: string;
  className?: string;
  label?: string;
}) {
  const { color, cells } = identicon(seed);
  return (
    <svg
      viewBox="0 0 6 6"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
      className={`shrink-0 rounded-[2px] ${className}`}
      data-testid="avatar"
      data-avatar-seed={seed}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
    >
      <rect width="6" height="6" fill={AVATAR_BACKGROUND} />
      {cells.map((filled, i) =>
        filled ? (
          <rect
            key={i}
            x={0.5 + (i % 5)}
            y={0.5 + Math.floor(i / 5)}
            width="1"
            height="1"
            fill={color}
          />
        ) : null,
      )}
    </svg>
  );
}
