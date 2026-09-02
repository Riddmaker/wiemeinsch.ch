# Restore — Wiederherstellung aus einem Offsite-Backup

Gegenstück zu `scripts/backup/backup.sh`. Zwei Anlässe:

1. **Der Quartalstest** (Regelfall): Ein Offsite-Dump wird in die lokale
   Compose-Umgebung zurückgespielt und die App dagegen gestartet. Ein Backup,
   das nie zurückgespielt wurde, ist keines.
2. **Der Ernstfall**: Wiederherstellung der Produktionsdatenbank.

Die Anleitung ist für beide dieselbe — es unterscheidet sich nur das Ziel.

---

## Was man braucht

| Sache | Woher |
|---|---|
| **Private age-Identität** | Passwortmanager/Offline-Speicher. Sie liegt bewusst **nicht** auf dem Produktionsnode (README → Deployment → Backup und Restore). |
| **Lesender S3-Zugang** | Eigene Zugangsdaten mit Leserecht — die Produktionsdaten sind write-only gescoped und können nicht lesen. |
| `pg_restore` und `age` | in der Major-Version des Zielservers (18). |

Ohne die private Identität ist kein Backup lesbar. Das ist beabsichtigt und der
Grund, warum ihr Aufbewahrungsort Teil des Betriebswissens ist.

---

## A. Restore-Test in die lokale Compose-Umgebung

### 1. Zielumgebung starten

```bash
docker compose up -d db
```

### 2. Verfügbare Backups auflisten

```bash
export BACKUP_S3_BUCKET=…  BACKUP_S3_ENDPOINT=…
export AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_DEFAULT_REGION=…

scripts/backup/restore.sh --list          # alle Klassen
scripts/backup/restore.sh --list monthly  # nur monatliche
```

### 3. In eine **Wegwerf-Datenbank** zurückspielen

Nie direkt über die Arbeitsdatenbank: erst in eine zweite Datenbank
restaurieren, dort prüfen, und erst dann entscheiden.

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'CREATE DATABASE restore_test'
```

Der Restore läuft in einem Wegwerf-Container mit den passenden Werkzeugen —
die lokale Datenbank veröffentlicht bewusst keinen Host-Port:

```bash
docker run --rm --network wiemeinschch_default \
  --env-file .env \
  -v "$PWD:/repo:ro" \
  -v "$HOME/backup-identity.txt:/key.txt:ro" \
  -e BACKUP_AGE_IDENTITY=/key.txt \
  -e PGHOST=db -e PGPORT=5432 \
  -e BACKUP_S3_BUCKET -e BACKUP_S3_ENDPOINT \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
  postgres:18 bash -c '
    apt-get update -qq && apt-get install -y -qq age awscli
    export PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD"
    PGDATABASE=restore_test bash /repo/scripts/backup/restore.sh \
      --key daily/wiemeinsch-YYYYmmddTHHMMSSZ.dump.age'
```

Das Skript prüft den Dump **vor** dem Schreiben (`pg_restore --list`): Ist die
Datei beschädigt, wird die Zieldatenbank gar nicht erst angefasst.

### 4. Prüfen

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d restore_test \
  -c 'SELECT count(*) FROM "Ticket"' \
  -c 'SELECT count(*) FROM "User"' \
  -c 'SELECT count(*) FROM "Statement"'
```

Die Zahlen müssen zum Stand der Sicherung passen. Danach die App gegen den
wiederhergestellten Stand starten: `DATABASE_URL` auf `restore_test` zeigen
lassen, `docker compose --profile prod up -d app-prod`, und im Browser prüfen,
dass Board, Ticket-Detail und Login funktionieren.

### 5. Aufräumen

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'DROP DATABASE restore_test'
```

Ergebnis des Tests protokollieren (Datum, verwendeter Dump, Zeilenzahlen,
Dauer) — der Test zählt nur, wenn sein Ergebnis nachvollziehbar ist.

---

## B. Ernstfall: Produktionsdatenbank wiederherstellen

**Reihenfolge ist hier alles.**

1. **App anhalten.** Den App-Node stoppen, damit nichts in die Datenbank
   schreibt, während sie ersetzt wird.
2. **Aktuellen Stand sichern**, auch wenn er kaputt aussieht: ein zweites
   Backup kostet Minuten und ist die einzige Rückfahrkarte, falls der Restore
   das Falsche wiederherstellt.
3. **Dump auswählen** (`restore.sh --list`) — im Zweifel den letzten, der
   sicher vor dem Schadensereignis liegt.
4. **In eine Wegwerf-Datenbank restaurieren und prüfen** (Schritte A.3/A.4).
   Erst wenn die Zahlen stimmen, weiter.
5. **Auf die Arbeitsdatenbank anwenden**: `PGDATABASE` auf die
   Produktionsdatenbank zeigen lassen und `restore.sh` erneut ausführen. Das
   Skript arbeitet mit `--clean --if-exists`, ersetzt also bestehende Objekte.
6. **Migrationsstand angleichen**: `npx prisma migrate deploy` — falls der Dump
   älter ist als die laufende Schema-Version.
7. **App starten**, `/api/health` prüfen, danach Board, Login und ein
   Ticket-Detail im Browser.
8. **Score-Recompute anstossen**, damit die Reihenfolge zum aktuellen Zeitpunkt
   passt statt zum Sicherungszeitpunkt (README → Deployment → Score-Recompute).

---

## Wenn etwas nicht klappt

| Symptom | Ursache | Vorgehen |
|---|---|---|
| `age: error: no identity matched any of the recipients` | falsche private Identität | Die zum `BACKUP_AGE_RECIPIENT` gehörende Identität verwenden — Backups aus verschiedenen Schlüsselgenerationen brauchen die jeweils passende. |
| `pg_restore: error: unsupported version` | `pg_restore` älter als der Dump | Werkzeuge in der Major-Version des Quellservers verwenden. |
| `pg_restore --list` schlägt fehl | Datei unvollständig oder beschädigt | Nächstälteren Dump nehmen. Ein abgebrochener Upload hinterlässt eine kürzere Datei — deshalb prüft das Skript zuerst das Inhaltsverzeichnis. |
| Zeilenzahlen viel kleiner als erwartet | Dump älter als gedacht, oder aus der falschen Klasse (`daily`/`weekly`/`monthly`) | Zeitstempel im Dateinamen prüfen; er ist UTC. |
| `Could not connect to the endpoint URL` | `BACKUP_S3_ENDPOINT` falsch oder kein Netzzugang | Endpoint der Swiss-Backup-Umgebung prüfen. |
