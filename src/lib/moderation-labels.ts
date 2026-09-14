import { getTranslations } from "next-intl/server";

/**
 * Grund-Codes eines Moderationsfalls in lesbare Bezeichnungen übersetzen
 * (P12.3, geteilt von Queue-Liste und Fall-Detail — HABIT 10).
 *
 * Die Codes sind serverseitig erzeugte Enum-Werte: Melde-Gründe stehen im
 * `moderation`-Katalog, Linter-Gründe im `linter`-Katalog. Fehlt ein Code im
 * Katalog, erscheint er roh statt einer leeren Zelle — ein Admin soll sehen,
 * worum es geht, auch wenn eine Übersetzung nachhinkt.
 */
export async function reasonLabels(
  type: "REPORT" | "APPEAL",
  reason: string,
): Promise<string[]> {
  const tModeration = await getTranslations("moderation");
  const tLinter = await getTranslations("linter");

  return reason
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => {
      if (type === "REPORT") {
        return tModeration.has(`reasons.${code}`)
          ? tModeration(`reasons.${code}`)
          : code;
      }
      return tLinter.has(`reasons.${code}`) ? tLinter(`reasons.${code}`) : code;
    });
}
