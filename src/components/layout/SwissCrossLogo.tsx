// Schweizer Kreuz im Kreis — SVG 1:1 aus Styleguide Art. 2 (offizielle
// Proportionen Armlänge 7 : Armbreite 6; nie verzerren, umfärben, Effekte).
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
      <circle cx="32" cy="32" r="32" fill="#DA291C" />
      <rect x="26" y="12" width="12" height="40" fill="#FFFFFF" />
      <rect x="12" y="26" width="40" height="12" fill="#FFFFFF" />
    </svg>
  );
}
