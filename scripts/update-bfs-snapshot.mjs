/**
 * Aktualisiert den versionierten BFS-Gemeindeverzeichnis-Snapshot (Entscheid E7).
 *
 * Quelle: Amtliches Gemeindeverzeichnis der Schweiz (BFS), AGVCH-Snapshot-API.
 * Aufruf:  node scripts/update-bfs-snapshot.mjs [TT-MM-JJJJ]   (Default: heute)
 *
 * Nach einem Update: `npx prisma db seed` erneut ausführen und die Zählungen
 * im Output gegen https://www.agvchapp.bfs.admin.ch prüfen.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXPECTED_COLUMNS = 12;
const TARGET = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prisma",
  "data",
  "bfs-communes-snapshot.csv",
);

const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const date =
  process.argv[2] ??
  `${pad(today.getDate())}-${pad(today.getMonth() + 1)}-${today.getFullYear()}`;

if (!/^\d{2}-\d{2}-\d{4}$/.test(date)) {
  console.error(`Ungültiges Datum "${date}" — erwartet TT-MM-JJJJ.`);
  process.exit(1);
}

const url = `https://www.agvchapp.bfs.admin.ch/api/communes/snapshot?date=${date}`;
console.log(`Lade Snapshot per ${date} von ${url} …`);

const res = await fetch(url);
if (!res.ok) {
  console.error(
    `BFS-API antwortete mit HTTP ${res.status} — Abbruch, Datei unverändert.`,
  );
  process.exit(1);
}
const csv = await res.text();

// Plausibilitätsprüfung vor dem Überschreiben des versionierten Snapshots.
const lines = csv.trim().split(/\r?\n/);
const rows = lines.slice(1).map((l) => l.split(","));
const broken = rows.filter((r) => r.length !== EXPECTED_COLUMNS).length;
const cantons = rows.filter((r) => r[4] === "1").length;
const communes = rows.filter((r) => r[4] === "3").length;

if (broken > 0 || cantons !== 26 || communes < 2000) {
  console.error(
    `Plausibilitätsprüfung fehlgeschlagen (kaputte Zeilen: ${broken}, Kantone: ${cantons}, Gemeinden: ${communes}) — Abbruch, Datei unverändert.`,
  );
  process.exit(1);
}

await writeFile(TARGET, csv, "utf8");
console.log(
  `OK: ${cantons} Kantone, ${communes} politische Gemeinden → ${TARGET}`,
);
