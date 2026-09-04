import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Öffentlicher @handle (P4, überarbeitet 04.09.2026).
 *
 * Der Handle steht öffentlich über jedem Ticket, Statement und Änderungsantrag
 * und ist NICHT änderbar. Er darf deshalb nichts über die Person verraten:
 * Bis 04.09.2026 wurde er aus dem Präfix der Mailadresse gebildet, womit sich
 * `vorname.nachname@…` dauerhaft im öffentlichen Profil wiederfand — ein
 * direkter Widerspruch zum Datenschutz-Grundsatz in REQUIREMENTS.md, der die
 * demografischen Felder gerade deshalb verbirgt, weil sie zusammen mit der
 * öffentlichen Abstimmungshistorie deanonymisieren.
 *
 * Stattdessen: ein Wort aus einer kuratierten Liste schweizerischer Seen,
 * Flüsse, Berge und Täler plus Zufallssuffix. Die Namen sind Eigennamen und in
 * allen drei Sprachregionen lesbar; die Liste enthält bewusst keine Personen-,
 * Amts- oder Parteibezeichnungen, damit kein Handle Autorität vortäuscht.
 */

/**
 * Kuratierte Wortliste (Seen, Flüsse, Berge, Täler), ASCII-normalisiert (Umlaute
 * transliteriert), damit der Handle ohne Escaping in URLs und `@`-Erwähnungen
 * funktioniert. Alle drei Sprachregionen sind vertreten.
 */
export const HANDLE_WORDS = [
  // Seen
  "bielersee",
  "blausee",
  "bodensee",
  "brienzersee",
  "caumasee",
  "ceresio",
  "daubensee",
  "greifensee",
  "hallwilersee",
  "kloentalersee",
  "lauerzersee",
  "leman",
  "lungerersee",
  "maggiore",
  "melchsee",
  "morat",
  "murtensee",
  "neuchatel",
  "neuenburgersee",
  "oeschinensee",
  "poschiavo",
  "ritom",
  "sempachersee",
  "sihlsee",
  "silsersee",
  "thunersee",
  "walensee",
  "zugersee",
  // Fluesse
  "aare",
  "areuse",
  "arve",
  "birs",
  "breggia",
  "broye",
  "doubs",
  "dranse",
  "emme",
  "glatt",
  "inn",
  "kander",
  "landquart",
  "limmat",
  "linth",
  "lonza",
  "moesa",
  "orbe",
  "plessur",
  "reuss",
  "rhein",
  "rhone",
  "saane",
  "sarine",
  "sihl",
  "simme",
  "sitter",
  "suze",
  "thur",
  "ticino",
  "toess",
  "tresa",
  "venoge",
  // Berge
  "aletschhorn",
  "bernina",
  "chasseral",
  "chasseron",
  "diablerets",
  "dufourspitze",
  "eiger",
  "finsteraarhorn",
  "fronalpstock",
  "generoso",
  "glaernisch",
  "gornergrat",
  "grammont",
  "jungfrau",
  "matterhorn",
  "moench",
  "moleson",
  "napf",
  "niesen",
  "pilatus",
  "rigi",
  "saentis",
  "schilt",
  "stockhorn",
  "suchet",
  "tamaro",
  "titlis",
  "toedi",
  "velan",
  "weisshorn",
  "wiggis",
  // Taeler
  "ajoie",
  "anniviers",
  "avers",
  "bagnes",
  "binntal",
  "blenio",
  "bregaglia",
  "calanca",
  "centovalli",
  "chablais",
  "diemtigtal",
  "emmental",
  "engadin",
  "entlebuch",
  "entremont",
  "goms",
  "gruyere",
  "herens",
  "illiez",
  "joux",
  "kandertal",
  "lauterbrunnen",
  "leventina",
  "loetschental",
  "maggia",
  "mattertal",
  "medel",
  "mesolcina",
  "muotatal",
  "onsernone",
  "praettigau",
  "saastal",
  "safiental",
  "sernftal",
  "simmental",
  "surselva",
  "tavetsch",
  "travers",
  "vals",
  "verzasca",
] as const;

/** Zeichenvorrat des Suffix: Ziffern und Kleinbuchstaben (Base36). */
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Regulärer Suffix; ~1,7 Mio. Varianten je Wort. */
export const HANDLE_SUFFIX_LENGTH = 4;

/** Ab der Hälfte der Versuche: längerer Suffix statt weiterer Blindversuche. */
const HANDLE_SUFFIX_LENGTH_RETRY = 6;

/** Versuche, bevor auf den kollisionsfreien UUID-Suffix ausgewichen wird. */
const MAX_ATTEMPTS = 8;

/**
 * `randomInt` statt `Math.random()`: Der Handle ist ein öffentlicher
 * Identifikator; ein vorhersagbarer PRNG erlaubte es, künftige Handles zu
 * erraten und vorab zu belegen.
 */
function randomSuffix(length: number): string {
  let suffix = "";
  for (let i = 0; i < length; i += 1) {
    suffix += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  }
  return suffix;
}

/** Ein Handle-Kandidat — ohne Eindeutigkeitsprüfung. */
export function generateHandle(
  suffixLength: number = HANDLE_SUFFIX_LENGTH,
): string {
  const word = HANDLE_WORDS[randomInt(HANDLE_WORDS.length)];
  return `${word}_${randomSuffix(suffixLength)}`;
}

/** Prisma meldet eine verletzte Unique-Constraint als `P2002` (Prisma 7.10). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Setzt einen eindeutigen Handle auf den User und gibt ihn zurück.
 *
 * `user.handle` ist `@unique`. Ohne Wiederholung würde eine Kollision den
 * `createUser`-Event werfen und die Registrierung kommentarlos abbrechen —
 * mit einer kurzen Wortliste ist das kein theoretischer Fall mehr. Geprüft
 * wird nicht vorab per `findUnique` (Race zwischen Prüfung und Schreiben),
 * sondern über den Constraint selbst.
 */
export async function assignHandle(userId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const suffixLength =
      attempt < MAX_ATTEMPTS / 2
        ? HANDLE_SUFFIX_LENGTH
        : HANDLE_SUFFIX_LENGTH_RETRY;
    const handle = generateHandle(suffixLength);
    try {
      await prisma.user.update({ where: { id: userId }, data: { handle } });
      return handle;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  // Letzte Instanz: praktisch kollisionsfrei, dafür weniger hübsch.
  const handle = `${HANDLE_WORDS[randomInt(HANDLE_WORDS.length)]}_${randomUUID()
    .replace(/-/g, "")
    .slice(0, 12)}`;
  await prisma.user.update({ where: { id: userId }, data: { handle } });
  return handle;
}
