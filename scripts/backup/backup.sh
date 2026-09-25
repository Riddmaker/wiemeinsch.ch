#!/usr/bin/env bash
#
# Nächtliches Backup der Produktionsdatenbank. Läuft per Cron im
# PostgreSQL-Node.
#
# Ablauf: pg_dump (Custom-Format, komprimiert) → age-Verschlüsselung → Upload
# in den S3-kompatiblen Offsite-Bucket. Mehr nicht.
#
# Keine Rotation auf dem Node (Code-Review 25.09.2026): Rotieren heisst
# auflisten und löschen. Zugangsdaten, die das dürfen, liessen einen
# kompromittierten Node die ganze Backup-Historie löschen. Der Node hat
# deshalb NUR Schreibrecht; die Aufbewahrung (GFS 7/4/12) regelt eine
# Lifecycle-Regel bzw. Object Lock am Bucket, je Präfix daily/ weekly/
# monthly/. Kann das Ziel das nicht, rotiert scripts/backup/rotate.sh vom
# Arbeitsplatz aus, mit eigenen Zugangsdaten.
#
# Zwei bewusste Eigenschaften:
#
#   1. Der Dump wird NIE unverschlüsselt auf die Platte geschrieben. pg_dump
#      schreibt nach stdout, age verschlüsselt im Strom, erst danach entsteht
#      eine Datei. Ein abgebrochener Lauf hinterlässt damit keinen lesbaren
#      Datenbestand auf dem Node.
#   2. Das DB-Passwort steht nur in der Umgebung (PGPASSWORD), nie in einer
#      Kommandozeile — Kommandozeilen sind über `ps` für jeden Prozess auf dem
#      Node sichtbar (HABIT 1).
#
# Benötigte Umgebungsvariablen (Namen, nie Werte):
#   PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
#   BACKUP_AGE_RECIPIENT      öffentlicher age-Schlüssel (age1...) — kein Secret
#   BACKUP_S3_BUCKET          Ziel-Bucket, z.B. wiemeinsch-backup
#   BACKUP_S3_ENDPOINT        Endpoint der Swiss-Backup-Umgebung
#   AWS_ACCESS_KEY_ID         write-only gescoped (nur PutObject)
#   AWS_SECRET_ACCESS_KEY
#   AWS_DEFAULT_REGION
# Optional (mit Defaults):
#   BACKUP_PREFIX=wiemeinsch
#   BACKUP_DRY_RUN=1     dumpt und verschlüsselt, lädt aber nichts hoch
#                        (für den lokalen Trockenlauf)

set -euo pipefail

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  log "FEHLER: $*" >&2
  exit 1
}

DRY_RUN="${BACKUP_DRY_RUN:-0}"
PREFIX="${BACKUP_PREFIX:-wiemeinsch}"

required=(PGHOST PGUSER PGDATABASE PGPASSWORD BACKUP_AGE_RECIPIENT)
if [ "${DRY_RUN}" != "1" ]; then
  required+=(BACKUP_S3_BUCKET BACKUP_S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY)
fi
for var in "${required[@]}"; do
  # Nur der NAME wird gemeldet, nie der Wert.
  [ -n "${!var:-}" ] || die "Umgebungsvariable ${var} fehlt."
done

for tool in pg_dump age; do
  command -v "${tool}" > /dev/null || die "${tool} ist auf diesem Node nicht installiert."
done
if [ "${DRY_RUN}" != "1" ]; then
  command -v aws > /dev/null || die "aws-CLI ist auf diesem Node nicht installiert."
fi

# --- GFS-Klasse bestimmen ---------------------------------------------------
# Ein Lauf gehört zu genau einer Klasse = einem Präfix im Bucket; die
# Aufbewahrung gilt je Präfix getrennt. Monatlich schlägt wöchentlich,
# wöchentlich schlägt täglich — sonst fiele ein Monatsbackup, das auf einen
# Sonntag fällt, aus der Monatsreihe heraus.
day_of_month="$(date -u +%d)"
day_of_week="$(date -u +%u)" # 1 = Montag ... 7 = Sonntag
if [ "${day_of_month}" = "01" ]; then
  CLASS=monthly
elif [ "${day_of_week}" = "7" ]; then
  CLASS=weekly
else
  CLASS=daily
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="${PREFIX}-${STAMP}.dump.age"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
TARGET="${WORKDIR}/${FILENAME}"

log "Backup ${FILENAME} (Klasse ${CLASS})"

# --- Dump + Verschlüsselung im Strom ----------------------------------------
# `set -o pipefail` sorgt dafür, dass ein Fehler in pg_dump nicht von einem
# erfolgreichen age verdeckt wird.
umask 077
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  | age --recipient "${BACKUP_AGE_RECIPIENT}" --output "${TARGET}"

size="$(wc -c < "${TARGET}" | tr -d ' ')"
[ "${size}" -gt 0 ] || die "Der erzeugte Dump ist leer."
log "Verschlüsselt: ${size} Bytes"

if [ "${DRY_RUN}" = "1" ]; then
  # Im Trockenlauf bleibt die Datei liegen, damit sie geprüft werden kann.
  cp "${TARGET}" "./${FILENAME}"
  log "Trockenlauf: kein Upload. Datei liegt unter ./${FILENAME}"
  exit 0
fi

# --- Offsite-Upload ---------------------------------------------------------
S3_BASE="s3://${BACKUP_S3_BUCKET}/${CLASS}"
aws --endpoint-url "${BACKUP_S3_ENDPOINT}" s3 cp "${TARGET}" "${S3_BASE}/${FILENAME}"
log "Hochgeladen nach ${S3_BASE}/${FILENAME}"

log "Backup abgeschlossen."
