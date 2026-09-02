import { execFileSync } from "node:child_process";

/**
 * Playwright-Global-Setup: bringt die denormalisierten Ticket-Scores vor dem
 * Lauf auf einen gemeinsamen Zeitpunkt (Entscheid E9, P14).
 *
 * Warum nötig: `score_trending` wird sonst nur beim jeweils letzten Ereignis
 * am Ticket geschrieben. Die Seed-Tickets tragen damit Werte, die zu
 * unterschiedlichen Uhrzeiten gerechnet wurden — die Board-Reihenfolge in
 * `vote-board.spec.ts` kippte dadurch mit zunehmendem Seed-Alter (Befund P13).
 * Ein Recompute unmittelbar vor dem Lauf stellt her, was die Formel meint:
 * alle Tickets zum selben Zeitpunkt bewertet.
 *
 * Zwei Wege zum SELBEN Skript (`npm run scores:recompute`), abhängig davon, ob
 * die Datenbank direkt erreichbar ist:
 *
 * 1. `DATABASE_URL` gesetzt (GitHub Actions, siehe docker-compose.ci.yml):
 *    direkter Aufruf auf dem Runner — Node und die Abhängigkeiten liegen dort
 *    schon, ein Container-Umweg brächte nur Laufzeit.
 * 2. Sonst (lokaler Normalfall): Wegwerf-Container am Compose-Netz, weil die
 *    DB lokal bewusst keinen Host-Port veröffentlicht. `docker compose run`
 *    aktiviert das Profil des Dienstes selbst — der Aufruf funktioniert
 *    deshalb neben dem Dev- wie neben dem Prod-Profil; `--no-deps` lässt die
 *    bereits laufende DB in Ruhe.
 */
export default function globalSetup(): void {
  const direct = Boolean(process.env.DATABASE_URL);
  const [command, args] = direct
    ? (["npm", ["run", "scores:recompute"]] as const)
    : ([
        "docker",
        [
          "compose",
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "app",
          "npm",
          "run",
          "scores:recompute",
        ],
      ] as const);

  try {
    const output = execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = output
      .split("\n")
      .find((l) => l.startsWith("Recompute fertig"));
    console.log(`[global-setup] ${line ?? "Recompute ausgeführt"}`);
  } catch (error) {
    const hint = direct
      ? "ist DATABASE_URL erreichbar?"
      : "läuft die Compose-Umgebung?";
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Score-Recompute vor dem E2E-Lauf fehlgeschlagen — ${hint} (${cause})`,
    );
  }
}
