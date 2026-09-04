import { diffWords, type DiffSegment } from "@/lib/text-diff";

/**
 * Wortweiser Diff eines Änderungsantrags (E13, 04.09.2026).
 *
 * Entfernt = durchgestrichen in Contra-Rot, hinzugefügt = Pro-Grün. Bewusst
 * dieselben zwei Farben wie bei den Statements (Styleguide Art. 5 reserviert
 * sie sonst dafür): Die Bedeutung «dagegen/dafür» und «weg/neu» ist dieselbe
 * Achse, zwei verschiedene Rot-Grün-Paare wären willkürlich.
 *
 * Die Farbe steht NIE allein: Entferntes ist zusätzlich durchgestrichen, und
 * beides nutzt `<del>`/`<ins>`, sodass Screenreader den Unterschied ansagen
 * (WCAG 1.4.1 — Information nicht nur über Farbe).
 *
 * Verglichen wird der reine Text: Fettschrift und Listen erscheinen im Diff
 * nicht als Formatierung. Der Diff soll zeigen, WAS sich ändert; die
 * formatierte Endfassung sieht der Autor beim Übernehmen im Editor.
 */
export function DiffView({
  before,
  after,
  testId,
}: {
  before: string;
  after: string;
  testId?: string;
}) {
  const segments: DiffSegment[] = diffWords(before, after);

  return (
    <p
      data-testid={testId}
      className="whitespace-pre-wrap font-serif text-[15.5px] leading-[1.7]"
    >
      {segments.map((segment, index) => {
        if (segment.type === "removed") {
          return (
            <del
              key={index}
              className="bg-[color-mix(in_srgb,var(--color-contra)_10%,transparent)] text-contra"
            >
              {segment.text}
            </del>
          );
        }
        if (segment.type === "added") {
          return (
            <ins
              key={index}
              className="bg-[color-mix(in_srgb,var(--color-pro)_12%,transparent)] text-pro no-underline"
            >
              {segment.text}
            </ins>
          );
        }
        return <span key={index}>{segment.text}</span>;
      })}
    </p>
  );
}
