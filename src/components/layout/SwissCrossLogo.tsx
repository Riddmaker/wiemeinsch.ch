// Schweizer Kreuz im Kreis — SVG 1:1 aus Styleguide Art. 2.
// Proportionen nach Wappenschutzgesetz, Anhang 2 (04.09.2026 nachgerechnet):
// Armbreite : Armlänge = 12 : 14 = 6 : 7 («je einen Sechstel länger als
// breit»), Kreuzbalken : Seite = 40 : 64 = 5 : 8, Randabstand = eine
// Balkenbreite. Rot = #E11A27 (Corporate Design Bund, Pantone 1797).
// Nie verzerren, umfärben, Effekte.
export function SwissCrossLogo({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={label}
      className={className}
    >
      <circle cx="32" cy="32" r="32" fill="#E11A27" />
      <rect x="26" y="12" width="12" height="40" fill="#FFFFFF" />
      <rect x="12" y="26" width="40" height="12" fill="#FFFFFF" />
    </svg>
  );
}
