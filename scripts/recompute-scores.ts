/**
 * Periodischer Recompute der denormalisierten Ticket-Scores (Entscheid E9,
 * P14). Aufruf:
 *
 *   npm run scores:recompute
 *
 * Braucht `DATABASE_URL` (aus `.env`, wird nie ausgegeben — HABIT 1). Im
 * Betrieb periodisch aufrufen; die Aufhängung (Cron auf der Infomaniak-
 * Umgebung) gehört ins Deployment-Runbook aus P15.
 *
 * Der Lauf ist idempotent: zweimal hintereinander ausgeführt schreibt er
 * dieselben Werte (bis auf das mit der Zeit sinkende Trending).
 */
import "dotenv/config";
import { recomputeAllTicketScores } from "@/services/scoring-recompute";

async function main(): Promise<void> {
  const startedAt = Date.now();
  const result = await recomputeAllTicketScores();
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(
    `Recompute fertig: ${result.tickets} Tickets gelesen, ${result.updated} Zeilen geschrieben (${seconds}s).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Recompute fehlgeschlagen:", error);
    process.exit(1);
  });
