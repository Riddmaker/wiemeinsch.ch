/**
 * Normalisierung der Login-Adresse für den Magic Link (25.09.2026).
 *
 * NextAuth v4 normalisiert von sich aus: NFKC, trim, genau ein `@`, keine
 * Anführungszeichen, lowercase — und schneidet die Domain beim ersten Komma
 * ab (`node_modules/next-auth/core/routes/signin.js`). Aus
 * `opfer@x.ch,1` und `opfer@x.ch,2` wurde so dieselbe Adresse, während das
 * Rate-Limit der Route noch zwei verschiedene sah — fünf Links pro Adresse
 * waren damit beliebig viele.
 *
 * Diese Funktion ist STRENGER und wird als `normalizeIdentifier` an den
 * EmailProvider übergeben: Was sie ablehnt, erreicht weder das Limit noch
 * den Mailversand. Kommas, Leerzeichen, Steuerzeichen und Überlängen sind in
 * einer echten Login-Adresse nie nötig.
 */

/** RFC 5321: ein Pfad darf 256 Zeichen haben, die Adresse darin 254. */
export const EMAIL_MAX_LENGTH = 254;

export class InvalidEmailIdentifierError extends Error {
  constructor() {
    super("Invalid email address format.");
    this.name = "InvalidEmailIdentifierError";
  }
}

/**
 * Normalisierte Adresse oder `InvalidEmailIdentifierError`. NextAuth fängt
 * den Fehler ab und leitet auf `/login/error?error=EmailSignin` um.
 */
export function normalizeEmailIdentifier(raw: string): string {
  const email = raw.normalize("NFKC").trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) {
    throw new InvalidEmailIdentifierError();
  }
  // Keine Leer-/Steuerzeichen, keine Listen- oder Kommentar-Syntax: genau
  // die Konstrukte, an denen Adressparser auseinanderlaufen.
  if (/[\s,;"<>()[\]\\\p{Cc}]/u.test(email)) {
    throw new InvalidEmailIdentifierError();
  }
  const parts = email.split("@");
  if (parts.length !== 2) {
    throw new InvalidEmailIdentifierError();
  }
  const [local, domain] = parts as [string, string];
  if (
    local.length === 0 ||
    domain.length < 3 ||
    !domain.includes(".") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    throw new InvalidEmailIdentifierError();
  }
  return `${local}@${domain}`;
}
