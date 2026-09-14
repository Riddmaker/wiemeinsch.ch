#!/usr/bin/env node
/**
 * Lokaler Secret-Scan über den Arbeitsbaum (P13.5).
 *
 * Warum lokal und nicht nur GitHub Secret Scanning: Der Remote-Scan sieht nur,
 * was gepusht wurde. Ein Fund wäre dann bereits ein Leak. Dieser Scan läuft
 * VOR dem Push über exakt die Dateien, die committed würden.
 *
 * HABIT 1 ist eingebaut: Es wird NIE ein gefundener Wert ausgegeben, nur
 * Datei, Zeile und der Name des Musters. Der Bericht kann damit gefahrlos in
 * ein Log, eine CI-Ausgabe oder ein LLM-Kontextfenster wandern.
 *
 * Aufruf:  node scripts/scan-secrets.mjs
 * Exit 0 = sauber, Exit 1 = Verdachtsfälle (jeder Fund ist zu prüfen).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/**
 * Muster für Anmeldedaten, die in diesem Projekt real vorkommen könnten.
 * Bewusst breit: ein Fehlalarm kostet eine Minute, ein Leak kostet Rotation.
 */
const PATTERNS = [
  { name: "PEM-Private-Key", re: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/ },
  { name: "AWS-Access-Key-Id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub-Token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub-Fine-Grained-Token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "Google-API-Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "OpenAI-artiger-Key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "Slack-Token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  {
    // Ein LITERALES Passwort in der URL. `${VAR}`-Interpolation (Compose,
    // Templates) ist kein Geheimnis und darf nicht als Fund gelten — sonst
    // gewöhnt man sich an rote Ausgaben und übersieht den echten Fall.
    name: "Verbindungs-URL mit Passwort",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@${}<>]+:[^\s@${}<>]{3,}@/,
  },
  {
    // Zuweisung eines nicht-leeren Literals an ein Geheimnis-Feld.
    name: "Zugewiesenes Geheimnis",
    re: /\b(?:password|passwd|secret|api[_-]?key|token|credential)s?\s*[:=]\s*["'`][^"'`\s${}<>]{8,}["'`]/i,
  },
];

/**
 * Fundstellen, die per Konstruktion keine echten Werte sind. Jede Ausnahme
 * ist begründungspflichtig — pauschale Verzeichnis-Ausnahmen gibt es nicht.
 */
const ALLOWLIST = [
  {
    // Offizielle, öffentlich dokumentierte Turnstile-Testschlüssel von
    // Cloudflare (E6). Sie schützen nichts und müssen im Klartext stehen,
    // damit die lokale Umgebung ohne Konto läuft.
    match: (file, line) =>
      /docker-compose\.yml|\.env\.example|tests[\\/]/.test(file) &&
      /[12]x0{20,}A{2}|XXXX/.test(line),
    reason: "Cloudflare-Turnstile-Testschlüssel (öffentlich dokumentiert)",
  },
  {
    // Platzhalter in der Vorlage: Namen ja, Werte nein.
    match: (file, line) =>
      /\.env\.example$/.test(file) && /<[^>]+>|=\s*$/.test(line),
    reason: "Platzhalter in .env.example",
  },
];

const SKIP_DIRS =
  /^(?:node_modules|\.next|\.git|dist|build|coverage|test-results|playwright-report)[\\/]/;
const SKIP_FILES = /(?:package-lock\.json|\.pdf|\.png|\.jpe?g|\.ico|\.webp)$/i;
const MAX_BYTES = 2_000_000;

/** Nur versionierte bzw. versionierbare Dateien — .env ist gitignored. */
function trackedFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !SKIP_DIRS.test(f) && !SKIP_FILES.test(f));
}

/** `.env` darf nie im Scan-Set auftauchen — sonst ist die Ignore-Regel kaputt. */
function assertEnvIgnored(files) {
  const leaked = files.filter(
    (f) => /(^|[\\/])\.env(\.|$)/.test(f) && !/\.example$/.test(f),
  );
  if (leaked.length > 0) {
    console.error(
      `FEHLER: .env-Dateien sind NICHT gitignored: ${leaked.join(", ")}`,
    );
    return false;
  }
  return true;
}

function allowed(file, line) {
  return ALLOWLIST.find((entry) => entry.match(file, line));
}

const files = trackedFiles();
const envOk = assertEnvIgnored(files);

const findings = [];
let skippedByAllowlist = 0;

for (const file of files) {
  let content;
  try {
    if (statSync(file).size > MAX_BYTES) continue;
    content = readFileSync(file, "utf8");
  } catch {
    continue; // Binär oder nicht lesbar
  }
  if (content.includes("\u0000")) continue;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      if (!re.test(lines[i])) continue;
      const exception = allowed(file, lines[i]);
      if (exception) {
        skippedByAllowlist++;
        continue;
      }
      // Absichtlich OHNE den Treffer selbst (HABIT 1).
      findings.push({ file, line: i + 1, pattern: name });
    }
  }
}

console.log(
  `Secret-Scan über ${files.length} Dateien (${PATTERNS.length} Muster)`,
);
console.log(`Bekannte Ausnahmen übersprungen: ${skippedByAllowlist}`);
console.log(`.env gitignored: ${envOk ? "ja" : "NEIN"}`);

if (findings.length === 0 && envOk) {
  console.log("Ergebnis: 0 Findings");
  process.exit(0);
}

for (const f of findings) {
  console.log(
    `FUND  ${f.file}:${f.line}  [${f.pattern}]  (Wert nicht ausgegeben)`,
  );
}
console.log(`Ergebnis: ${findings.length} Verdachtsfälle`);
process.exit(1);
