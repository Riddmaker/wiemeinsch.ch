/**
 * Deterministische Verortung eines LLM-Zitats im Originaltext
 * (Stolperstein: LLM-Ranges stimmen nicht immer
 * zeichengenau). Strategie in absteigender Präzision:
 *   1. exakte Teilstring-Suche,
 *   2. normalisierte Suche (Whitespace/Anführungszeichen vereinheitlicht),
 *   3. Fuzzy-Match auf Satz-Ebene (Bigram-Dice-Ähnlichkeit),
 *   4. Fallback: ganzer Text.
 * Das Resultat liegt damit IMMER innerhalb des Textes (P6.4: Ranges müssen
 * im Text liegen) — Offsets im selben plainText-Raum wie die Editor-
 * Highlight-API aus P5.
 */

export type QuoteMatchMethod = "exact" | "normalized" | "sentence" | "fallback";

export type QuoteRange = {
  from: number;
  to: number;
  method: QuoteMatchMethod;
};

/** Mindest-Ähnlichkeit, ab der ein Satz als Fuzzy-Treffer gilt. */
const SENTENCE_SIMILARITY_THRESHOLD = 0.5;

/**
 * Normalisiert für den Vergleich: Kleinschreibung, typografische
 * Anführungszeichen vereinheitlicht, Whitespace-Läufe zu einem Leerzeichen.
 * `map[i]` = Index des Zeichens im Originalstring.
 */
function normalizeWithMap(input: string): { norm: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < input.length; i += 1) {
    let ch = input[i]!.toLowerCase();
    if (/["'„“”‚‘’«»‹›]/.test(ch)) {
      ch = "'";
    }
    if (/\s/.test(ch)) {
      pendingSpace = chars.length > 0;
      continue;
    }
    if (pendingSpace) {
      chars.push(" ");
      map.push(map.length > 0 ? map[map.length - 1]! : i);
      pendingSpace = false;
    }
    chars.push(ch);
    map.push(i);
  }

  return { norm: chars.join(""), map };
}

function characterBigrams(input: string): Map<string, number> {
  const bigrams = new Map<string, number>();
  for (let i = 0; i < input.length - 1; i += 1) {
    const bigram = input.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  return bigrams;
}

/** Sørensen-Dice-Koeffizient über Zeichen-Bigramme, Wertebereich [0, 1]. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  if (a.length < 2 || b.length < 2) {
    return 0;
  }
  const bigramsA = characterBigrams(a);
  const bigramsB = characterBigrams(b);
  let overlap = 0;
  for (const [bigram, countA] of bigramsA) {
    const countB = bigramsB.get(bigram);
    if (countB !== undefined) {
      overlap += Math.min(countA, countB);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

type SentenceSpan = { from: number; to: number };

/** Zerlegt Text in Satz-Spans (Satzzeichen oder Zeilenumbruch als Grenze). */
export function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const boundary = /[.!?…]+(?=\s|$)|\n+/g;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    pushSpan(spans, text, start, end);
    start = end;
  }
  pushSpan(spans, text, start, text.length);
  return spans;
}

function pushSpan(
  spans: SentenceSpan[],
  text: string,
  from: number,
  to: number,
): void {
  // Führenden/abschliessenden Whitespace aus dem Span kürzen.
  while (from < to && /\s/.test(text[from]!)) {
    from += 1;
  }
  while (to > from && /\s/.test(text[to - 1]!)) {
    to -= 1;
  }
  if (to > from) {
    spans.push({ from, to });
  }
}

export function locateQuote(text: string, quote: string): QuoteRange {
  // 1. Exakter Treffer.
  const exactIndex = text.indexOf(quote);
  if (exactIndex >= 0) {
    return { from: exactIndex, to: exactIndex + quote.length, method: "exact" };
  }

  // 2. Normalisierter Treffer, über die Index-Map zurückübersetzt.
  const { norm: normText, map } = normalizeWithMap(text);
  const { norm: normQuote } = normalizeWithMap(quote);
  if (normQuote.length > 0) {
    const normIndex = normText.indexOf(normQuote);
    if (normIndex >= 0) {
      const from = map[normIndex]!;
      const lastNormIndex = normIndex + normQuote.length - 1;
      const to = map[lastNormIndex]! + 1;
      return { from, to, method: "normalized" };
    }
  }

  // 3. Fuzzy: ähnlichster Satz.
  let best: { span: SentenceSpan; score: number } | null = null;
  for (const span of splitSentences(text)) {
    const { norm: normSentence } = normalizeWithMap(
      text.slice(span.from, span.to),
    );
    const score = diceSimilarity(normSentence, normQuote);
    if (
      score >= SENTENCE_SIMILARITY_THRESHOLD &&
      (best === null || score > best.score)
    ) {
      best = { span, score };
    }
  }
  if (best !== null) {
    return { from: best.span.from, to: best.span.to, method: "sentence" };
  }

  // 4. Deterministischer Fallback: ganzer Text.
  return { from: 0, to: text.length, method: "fallback" };
}
