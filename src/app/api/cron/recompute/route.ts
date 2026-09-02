import { createHash, timingSafeEqual } from "node:crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { recomputeAllTicketScores } from "@/services/scoring-recompute";

/**
 * Aufhängung des periodischen Score-Recomputes (Entscheid E9) in der
 * Zielumgebung — P15.2b.
 *
 * Warum eine Route und kein Cron-Aufruf von `npm run scores:recompute`: Das
 * Laufzeit-Image ist der Standalone-Build (`server.js` + getracte Abhängig-
 * keiten). Es enthält weder `scripts/` noch `tsx` — der npm-Befehl existiert
 * dort schlicht nicht. Die Route ruft denselben Service auf, den auch das
 * lokale Skript nutzt; die Formel bleibt an EINER Stelle (HABIT 10).
 *
 * Erreichbarkeit: Der Scheduler ruft sie intern im Umgebungsnetz auf
 * (`http://app:3000`). Sie ist damit kein öffentlicher Endpunkt — zusätzlich
 * empfiehlt README → Deployment eine Cloudflare-Regel, die `/api/cron/*` am Rand
 * abweist (Defense in Depth).
 *
 * Schutz:
 *   - Ohne konfiguriertes `CRON_SECRET` verhält sich die Route, als gäbe es
 *     sie nicht (404) — lokal ist sie damit standardmässig tot.
 *   - Falscher oder fehlender Schlüssel: ebenfalls 404, nie 401/403. Ein
 *     abweichender Status wäre ein Orakel, das die Existenz der Route
 *     verrät (P13: keine Informations-Leaks).
 *   - Der Vergleich läuft zeitkonstant über SHA-256-Digests: gleiche Länge
 *     unabhängig von der Eingabe, keine Rückschlüsse aus der Antwortzeit.
 *   - Zusätzlich ein Fenster-Limit: der stündliche Lauf braucht eine
 *     Ausführung, alles darüber ist Missbrauch oder ein Fehler im Scheduler.
 */

export const dynamic = "force-dynamic";

/** Ein Recompute je Stunde ist der Takt; das Limit lässt Nachholläufe zu. */
const LIMIT_PER_WINDOW = 4;
const WINDOW_SECONDS = 900;

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function keyMatches(provided: string | null, expected: string): boolean {
  if (!provided) {
    return false;
  }
  // Digests statt Rohwerte: `timingSafeEqual` verlangt gleich lange Puffer und
  // würde bei unterschiedlicher Länge werfen — die Länge des Secrets wäre
  // damit über den Fehlerpfad messbar.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return notFound();
  }
  if (!keyMatches(request.headers.get("x-cron-key"), secret)) {
    return notFound();
  }

  const limit = await checkRateLimit({
    scope: "cron-recompute",
    identifier: "global",
    limit: LIMIT_PER_WINDOW,
    windowSeconds: WINDOW_SECONDS,
  });
  if (!limit.ok) {
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  const result = await recomputeAllTicketScores();
  return Response.json({ tickets: result.tickets, updated: result.updated });
}

/**
 * Ohne diesen Handler beantwortete Next einen GET mit 405 — und verriete
 * damit, dass unter dem Pfad etwas liegt. Die Route soll sich für jeden
 * unberechtigten Zugriff gleich verhalten.
 */
export function GET(): Response {
  return notFound();
}
