# wiemeinsch.ch

Das „Civic-Jira" für die Schweiz: eine Plattform, auf der Bürgerinnen und Bürger
politische Probleme als Tickets einreichen und gemeinsam an Lösungen arbeiten.
Sie belohnt Konsens und bestraft Ragebait — statt einer Kommentarspalte gibt es
**Political Pull Requests** für konstruktive Gegenvorschläge, und ein
KI-gestützter **Civic-Linter** blockiert Polemik, bevor sie publiziert wird.

Mehrsprachig in Deutsch, Französisch und Italienisch: Jeder Beitrag wird beim
Publizieren in alle drei Landessprachen übersetzt, die Originalsprache bleibt
ausgewiesen.

---

## Inhalt

- [Kernideen](#kernideen)
- [Technischer Überblick](#technischer-überblick)
- [Lokale Entwicklung](#lokale-entwicklung)
- [Tests](#tests)
- [Deployment](#deployment)
  - [Was die Pipeline tut](#was-die-pipeline-tut)
  - [GitHub-Secrets](#github-secrets)
  - [Zielumgebung einrichten](#zielumgebung-einrichten)
  - [Cloudflare](#cloudflare)
  - [Periodische Aufgabe: Score-Recompute](#periodische-aufgabe-score-recompute)
  - [Backup und Restore](#backup-und-restore)
  - [Wartung](#wartung)
  - [Go-Live-Checkliste](#go-live-checkliste)
- [Lizenz](#lizenz)

---

## Kernideen

| Mechanismus | Was er bewirkt |
|---|---|
| **Civic-Linter** | Zweistufige KI-Prüfung vor dem Publizieren: erst ein Moderations-Modell gegen Toxizität und Prompt-Injection, dann ein Sprachmodell gegen Polemik und Unsachlichkeit. Wer blockiert wird, sieht die beanstandete Stelle und kann umformulieren — oder den Entscheid anfechten. |
| **Political Pull Request** | Wer die Lösung eines fremden Tickets verbessern will, stellt einen Änderungsantrag. Nur die Autorschaft entscheidet über den Merge; wird gemergt, wird die antragstellende Person Co-Autor. |
| **Statement-Dashboard** | Beiträge sind kategorisiert (Pro, Contra, Erweiterung, Frage) — und es gibt **keine Antwortfunktion**. Ohne Threads entsteht kein Schlagabtausch. |
| **Drei Ranglisten** | *Konsens* (Wilson-Untergrenze — breite Zustimmung schlägt laute Nische), *Kontrovers* (macht Spaltung sichtbar, statt sie zu belohnen) und *Trending* (Aktivität mit Zeitverfall). |
| **Datensparsamkeit** | Demografische Angaben sind freiwillig und verlassen den Server nie pro Person. Ein dauerhafter Test schlägt fehl, sobald eine dieser Spalten irgendwo ausserhalb der erlaubten Stellen auftaucht. |

## Technischer Überblick

- **Next.js 16** (App Router, Turbopack, React 19, TypeScript strict)
- **PostgreSQL 18** über **Prisma 7** mit `@prisma/adapter-pg`
- **next-intl** für DE/FR/IT, **NextAuth v4** (Magic Link + Google OAuth)
- **Mistral AI** für Civic-Linter und Übersetzung
- **TipTap** als eingeschränkter Editor (nur fett, kursiv, Aufzählung)
- **Tailwind 4** nach einem eigenen Styleguide im Stil des Swiss Design
- Container: Multi-Stage-`Dockerfile`, Non-Root-Runtime, Healthcheck `/api/health`

Architekturprinzipien, die im Code durchgesetzt werden:

- **Server Actions sind der einzige Mutationsweg.** Client-Komponenten
  importieren nie direkt aus `src/services/` oder `src/lib/prisma.ts`.
- **Zeichenlimiten und LLM-Antwortformate leben in `src/lib/validation/`** und
  werden von Formular und Server Action gemeinsam importiert — keine doppelt
  gepflegten Grenzen.
- **UI-Texte stehen ausschliesslich in `messages/`** (de/fr/it), nie im Code.
- **Rate-Limiting** in PostgreSQL, zweischichtig (pro Konto und pro IP), mit
  einem gemeinsamen Budget über alle KI-Endpunkte.
- **CSP mit Nonce und `strict-dynamic`**, Ausgabe von LLM-Inhalten
  ausschliesslich als Text.

## Lokale Entwicklung

Voraussetzungen: Node.js ≥ 24, npm ≥ 11, Docker Desktop.

```bash
npm ci                  # exakte Versionen aus package-lock.json
cp .env.example .env    # lokale Werte eintragen — .env wird nie committet
docker compose up -d    # App (Hot Reload), PostgreSQL, Mailpit
npx prisma migrate deploy
npx prisma db seed      # Stammdaten + Testdaten
```

Die App läuft auf `http://localhost:3000`, der Mail-Fänger **Mailpit** auf
`http://localhost:8025` (dort landen die Magic-Link-Mails).

Die Datenbank veröffentlicht **bewusst keinen Host-Port** — Zugriff nur aus dem
Compose-Netz (`docker compose exec db psql …`).

**Zwei Compose-Modi:**

```bash
docker compose up                          # Dev: next dev mit Hot Reload
docker compose --profile prod up --build   # Prod: exakt das Image der Pipeline
```

Vor jedem Push wird gegen das **Prod-Profil** getestet, nicht gegen `next dev`.

Qualitätsschranken — alle müssen grün sein:

```bash
npm run lint            # ESLint
npm run typecheck       # tsc --noEmit
npm run format:check    # Prettier
npm run test            # Vitest (tests/unit)
npm run test:e2e        # Playwright (tests/e2e), braucht die Compose-Umgebung
npm run scan:secrets    # Pre-Push-Scan auf Anmeldedaten im Arbeitsbaum
```

## Tests

- **Unit** (`tests/unit/`): Services, Scoring-Formeln, Zod-Schemas, die
  vollständige Access-Control-Matrix, Katalog-Gleichheit DE/FR/IT.
- **E2E** (`tests/e2e/`): Playwright gegen die lokale Compose-Instanz, inklusive
  Barrierefreiheits-Abnahme mit axe-core (WCAG 2.1 A/AA, Schwelle 0 Verstösse
  der Stufen *critical*/*serious*) und einer Sicht-Abnahme über
  Sprache × Kernseite × {375, 1280} px.
- **`@ai`-Markierung:** Tests, die echte Mistral-Aufrufe auslösen, tragen dieses
  Tag. Die Pipeline fährt `--grep-invert "@ai"` — sie kosten API-Budget und
  würden jeden Merge von einer externen API abhängig machen. Lokal läuft die
  Suite vollständig, und genau das ist die Abnahme vor dem Push.
- **Login-Budget:** Magic Links sind auf 5 pro Adresse und 15 Minuten begrenzt.
  Ein Suite-Lauf bleibt darunter; zwei volle Läufe in einer Viertelstunde nicht
  — das ist die Bremse, die funktioniert, kein Testfehler.

---

# Deployment

Dieser Abschnitt richtet sich an den Betreiber der Umgebung. Die Schritte in der
Infomaniak-Jelastic-Konsole und im Cloudflare-Dashboard kann nur der Eigentümer
ausführen; hier stehen sie als Anleitung.

> **Grundregel:** Secrets werden ausschliesslich als Umgebungsvariablen bzw.
> GitHub-Actions-Secrets gesetzt — nie in einer Datei im Repository, nie in
> einer Kommandozeile, die in `ps` oder in einem Build-Log landet.

## Was die Pipeline tut

Auslöser: ein Push auf `main` (in der Regel ein gemergter PR aus `dev`), oder
ein manueller Start über *Actions → Deploy → Run workflow*.

| Stufe | Job | Bricht ab, wenn |
|---|---|---|
| 1 | `quality` — Secret-Scan, ESLint, TypeScript, Prettier, Unit-Tests | eine Prüfung rot ist |
| 2 | `e2e` — Compose-Umgebung im Runner, echtes Prod-Image, Playwright ohne `@ai`-Specs | ein E2E-Test fehlschlägt |
| 3 | `build-push` — Image bauen, nach GHCR pushen, mit cosign signieren, Provenance attestieren, Signatur sofort gegenprüfen | Build, Push, Signatur oder Verifikation fehlschlägt |
| 4 | `deploy` — Redeploy-Webhook der Jelastic-Umgebung | das Secret fehlt oder der Webhook nicht mit 2xx antwortet |

**Kein Image wird publiziert, wenn die Tests rot sind, und kein Redeploy wird
angestossen, wenn die Signatur nicht verifizierbar ist.**

Das Image landet als `ghcr.io/riddmaker/wiemeinsch.ch`, getaggt mit dem
Commit-SHA (unveränderlich) und `latest`.

## GitHub-Secrets

| Name | Wo einzutragen | Inhalt |
|---|---|---|
| `JELASTIC_REDEPLOY_WEBHOOK` | Settings → Secrets and variables → Actions | Vollständige Webhook-URL der Jelastic-Umgebung inklusive Token |

`GITHUB_TOKEN` stellt Actions automatisch bereit und deckt den GHCR-Push ab.

Optionale Härtung: den `deploy`-Job an eine GitHub-*Environment* mit *Required
reviewers* binden — dann wartet jedes Deployment auf eine manuelle Freigabe,
während Build und Signatur bereits gelaufen sind.

## Zielumgebung einrichten

Vier Nodes:

1. **App-Node (Custom Container)** — Image `ghcr.io/riddmaker/wiemeinsch.ch:latest`
2. **PostgreSQL-Node** — offizielles `postgres`-Image, Major-Version **18**
   gepinnt (identisch zur lokalen Compose-Umgebung)
3. **Storage-Node** — exportiert das Volume, das als `PGDATA` in den
   PostgreSQL-Node gemountet wird
4. **`cloudflared`-Node** — Cloudflare Tunnel

Interne Verbindungswege, sonst nichts: `cloudflared → App:3000` und
`App → PostgreSQL:5432`. Kein Node exponiert einen öffentlichen Port.

### Registry-Zugang (Pull)

1. Auf GitHub ein **Personal Access Token mit ausschliesslich `read:packages`**
   erzeugen — kein `write:packages`, kein `repo`.
2. Im App-Node als Registry-Zugangsdaten hinterlegen.

### Signaturprüfung vor jedem Redeploy

Der Redeploy-Hook führt **vor** dem Neustart des Containers aus:

```bash
cosign verify ghcr.io/riddmaker/wiemeinsch.ch:latest \
  --certificate-identity \
    https://github.com/Riddmaker/wiemeinsch.ch/.github/workflows/deploy.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Exit-Code ≠ 0 ⇒ **nicht deployen**, die laufende Version bleibt stehen. Es ist
derselbe Befehl, den die Pipeline unmittelbar nach dem Signieren selbst fährt.
Die Umgebung braucht dafür `cosign` 3.x, passend zur gepinnten Version der
Pipeline.

### Umgebungsvariablen des App-Nodes

Namen wie in `.env.example`; Werte ausschliesslich in der Jelastic-Umgebung:

| Variable | Anmerkung für die Produktion |
|---|---|
| `DATABASE_URL` | zeigt auf den internen PostgreSQL-Node |
| `NEXTAUTH_URL` | `https://wiemeinsch.ch` |
| `NEXTAUTH_SECRET` | langer Zufallswert, z.B. `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Produktions-OAuth-Client |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Infomaniak-SMTP — **nicht** Mailpit |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Produktionsschlüssel, **nicht** die Testschlüssel |
| `TRUST_PROXY` | **`true`** — nur hinter Cloudflare dürfen Proxy-Header gelesen werden |
| `MISTRAL_API_KEY` | Produktionsschlüssel mit Budget-Limit |
| `MISTRAL_MODERATION_MODEL`, `MISTRAL_LINTER_MODEL`, `MISTRAL_TRANSLATE_MODEL` | Modell-IDs; nie im Code |
| `CRON_SECRET` | Schlüssel des Cron-Endpunkts, siehe unten |

`TRUST_PROXY=true` ist kein Komfortschalter: davon hängt ab, ob das
IP-Rate-Limiting überhaupt greift. Lokal steht es auf `false`, weil dort kein
Tunnel davorsteht und jeder IP-Header fälschbar wäre.

### Datenbank-Schema

Die Pipeline migriert **nicht** automatisch — ein Schema-Wechsel ist ein
bewusster Schritt mit Backup davor. Vor dem ersten Start und nach jeder neuen
Migration:

```bash
npx prisma migrate deploy
```

Beim Aufsetzen zusätzlich die Stammdaten (Gemeindeverzeichnis, Kategorien)
einspielen. Die Dev-Testdaten aus `prisma/seed.ts` gehören **nicht** in die
Produktion.

## Cloudflare

1. `wiemeinsch.ch` liegt bei Cloudflare (DNS + Proxy).
2. Im Zero-Trust-Dashboard einen **Tunnel** anlegen; das Tunnel-Token
   ausschliesslich als Umgebungsvariable im `cloudflared`-Node hinterlegen.
3. Public Hostname: `wiemeinsch.ch` → `http://app:3000`.
4. TLS-Modus **Full (strict)**, HSTS aktivieren.
5. WAF und Edge-Rate-Limiting aktivieren — als äussere Schicht **zusätzlich**
   zum applikationsseitigen Rate-Limiting, nie als Ersatz.
6. Empfohlene WAF-Regel: Anfragen auf `/api/cron/*` am Rand abweisen.

Nach dem Aufsetzen prüfen: Die Origin-IP darf von aussen nicht erreichbar sein.
Ein Port-Scan gegen die eigene Umgebung darf keinen offenen Port zeigen.

## Periodische Aufgabe: Score-Recompute

`score_trending` hängt am Alter eines Tickets, wird aber nur bei einem Ereignis
am Ticket geschrieben. Ohne Auffrischung behält ein inaktives Ticket dauerhaft
seinen zu hohen Wert und die Board-Reihenfolge driftet von der Formel weg.

**Takt: stündlich.** Aufruf über den internen Endpunkt:

```bash
curl -fsS -X POST \
  -H "X-Cron-Key: ${CRON_SECRET}" \
  http://app:3000/api/cron/recompute
```

Warum nicht `npm run scores:recompute` wie lokal: Das Laufzeit-Image ist der
Next-Standalone-Build und enthält weder `scripts/` noch `tsx` — der npm-Befehl
existiert dort nicht. Der Endpunkt ruft denselben Service auf; die Formel bleibt
an einer Stelle.

Eigenschaften des Endpunkts:

- Ohne gesetztes `CRON_SECRET` antwortet er **404** — lokal ist er damit
  standardmässig tot.
- Falscher oder fehlender Schlüssel: ebenfalls **404**, nie 401/403. Ein
  abweichender Status wäre ein Orakel über die Existenz der Route.
- Der Lauf ist idempotent, schreibt nur die drei Score-Spalten und lässt
  `updatedAt` unberührt.
- Antwort im Erfolgsfall: `{"tickets":N,"updated":N}` — für das Cron-Log.

`CRON_SECRET` wird an **zwei** Stellen gesetzt: in der App-Umgebung und im
Scheduler.

## Backup und Restore

Skripte: `scripts/backup/backup.sh` (nächtlich) und `scripts/backup/restore.sh`.
Der Wiederherstellungsweg steht Schritt für Schritt in **[`RESTORE.md`](RESTORE.md)**.

### Voraussetzungen auf dem PostgreSQL-Node

- `pg_dump` in **derselben Major-Version wie der Server** (18). Ein älterer
  `pg_dump` verweigert die Arbeit gegen einen neueren Server.
- `age` (Verschlüsselung) und die `aws`-CLI (S3-kompatibler Upload).

### Schlüsselpaar erzeugen

Einmalig, **nicht** auf dem Produktionsnode:

```bash
age-keygen -o backup-identity.txt      # enthält den PRIVATEN Schlüssel
age-keygen -y backup-identity.txt      # gibt den öffentlichen Empfänger aus
```

- Der **öffentliche** Empfänger (`age1…`) kommt als `BACKUP_AGE_RECIPIENT` auf
  den Produktionsnode. Damit kann dieser nur verschlüsseln, nicht entschlüsseln.
- Die **private** Identität gehört in einen Passwortmanager oder Offline-Speicher
  — niemals auf denselben Node und niemals ins Repository. Wer sie verliert,
  verliert alle Backups; wer sie und den Bucket hat, hat die Daten.

### Umgebungsvariablen des PostgreSQL-Nodes

`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`,
`BACKUP_AGE_RECIPIENT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`.
Optional: `BACKUP_KEEP_DAILY` (7), `BACKUP_KEEP_WEEKLY` (4),
`BACKUP_KEEP_MONTHLY` (12), `BACKUP_PREFIX` (`wiemeinsch`).

Die S3-Zugangsdaten sind **write-only gescoped**: Ein kompromittierter
Produktionsnode kann damit keine alten Backups lesen.

### Cron

```
0 2 * * *   /pfad/zu/scripts/backup/backup.sh >> /var/log/backup.log 2>&1
```

Der Lauf entscheidet selbst über die Ablage: am 1. des Monats `monthly/`,
sonntags `weekly/`, sonst `daily/`. Rotation je Klasse getrennt (7/4/12) —
ältere Dateien werden nach dem Upload entfernt.

Der Dump liegt **zu keinem Zeitpunkt unverschlüsselt auf der Platte**:
`pg_dump` schreibt in eine Pipe, `age` verschlüsselt im Strom.

### Restore-Test

Mindestens quartalsweise einen Offsite-Dump in die lokale Compose-Umgebung
zurückspielen und die App dagegen starten. Ein Backup, das nie zurückgespielt
wurde, ist keines.

## Wartung

- **Action-Versionen** im Workflow sind exakt gepinnt. Nächste Härtungsstufe
  wäre das Pinnen auf Commit-SHAs; Dependabot kann beides aktuell halten.
- **`cosign` ist auf `v3.0.6` gepinnt.** Cosign 3 hat die Signatur-Defaults
  geändert (Protobuf-Bundle, OCI-1.1-Referrer); ein unbemerkter Versionswechsel
  auf der einen Seite bricht die Verifikation auf der anderen. Pipeline und
  Umgebung immer gemeinsam anheben.
- **PostgreSQL-Major-Upgrades** sind ein bewusster manueller Schritt mit
  frischem Backup davor — und mit angepasster `pg_dump`-Version im Backup-Node.
- **GitHub Secret Scanning + Push Protection** im Repository aktivieren
  (Settings → Code security). Das ergänzt den lokalen `npm run scan:secrets` um
  die Prüfung nach dem Push.

## Go-Live-Checkliste

- [ ] **Impressum:** echte Adresse des Betreibers in `messages/*.json` statt der
      Platzhalter; `kontakt@wiemeinsch.ch` existiert und wird gelesen
- [ ] **Turnstile:** Produktionsschlüssel gesetzt — die Testschlüssel (`1x…AA`)
      lassen jede Anfrage durch
- [ ] **Google OAuth:** Produktions-Client mit Redirect-URI
      `https://wiemeinsch.ch/api/auth/callback/google`
- [ ] **Mistral:** Produktionsschlüssel mit **Budget-Limit** im Anbieter-Konto
- [ ] **SMTP:** Zugang gesetzt, Testmail zugestellt, Absender mit gültigem
      SPF/DKIM
- [ ] **`NEXTAUTH_SECRET`** frisch erzeugt (nicht aus der lokalen `.env`)
- [ ] **`TRUST_PROXY=true`** gesetzt
- [ ] **`CRON_SECRET`** gesetzt, Scheduler eingerichtet, ein Lauf im Log
      bestätigt
- [ ] **Migrationen** eingespielt; **keine** Dev-Testdaten in der
      Produktionsdatenbank
- [ ] **Backup** einmal manuell ausgeführt und **einmal restauriert**
- [ ] **Cloudflare:** Tunnel aktiv, Full (strict), HSTS, WAF-Regel für
      `/api/cron/*`; Port-Scan gegen die eigene Origin zeigt nichts Offenes
- [ ] **cosign-Verifikation** im Redeploy-Hook aktiv und einmal absichtlich
      fehlschlagend getestet (falsche Identität ⇒ kein Deploy)
- [ ] **GitHub Secret Scanning + Push Protection** aktiviert
- [ ] `/api/health` über `https://wiemeinsch.ch` antwortet mit 200

---

## Lizenz

[PolyForm Noncommercial License 1.0.0](LICENSE.md) — frei für Bürgerinnen und
Bürger, NGOs, Bildungs- und Regierungsinstitutionen. Kommerzielle Nutzung
erfordert eine separate Lizenz des Rechteinhabers.

Required Notice: Copyright Cedric Meier (https://wiemeinsch.ch)
