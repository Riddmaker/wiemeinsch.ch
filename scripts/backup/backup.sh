#!/usr/bin/env bash
#
# Nächtliches Backup der Produktionsdatenbank. Läuft per Cron im
# PostgreSQL-Node.
#
# Ablauf: pg_dump (Custom-Format, komprimiert) → age-Verschlüsselung → Upload
# in den S3-kompatiblen Offsite-Bucket → GFS-Rotation.
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
# Benötigte Umgebungsvariablen (Namen, nie Werte, siehe README → Deployment):
#   PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
#   BACKUP_AGE_RECIPIENT      öffentlicher age-Schlüssel (age1...) — kein Secret
#   BACKUP_S3_BUCKET          Ziel-Bucket, z.B. wiemeinsch-backup
#   BACKUP_S3_ENDPOINT        Endpoint der Swiss-Backup-Umgebung
#   AWS_ACCESS_KEY_ID         write-only gescoped
#   AWS_SECRET_ACCESS_KEY
#   AWS_DEFAULT_REGION
# Optional (mit Defaults):
#   BACKUP_KEEP_DAILY=7  BACKUP_KEEP_WEEKLY=4  BACKUP_KEEP_MONTHLY=12
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
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"

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
# Ein Lauf gehört zu genau einer Klasse; die Rotation zählt je Klasse getrennt.
# Monatlich schlägt wöchentlich, wöchentlich schlägt täglich — sonst fiele ein
# Monatsbackup, das auf einen Sonntag fällt, aus der Monatsreihe heraus.
day_of_month="$(date -u +%d)"
day_of_week="$(date -u +%u)" # 1 = Montag ... 7 = Sonntag
if [ "${day_of_month}" = "01" ]; then
  CLASS=monthly
  KEEP="${KEEP_MONTHLY}"
elif [ "${day_of_week}" = "7" ]; then
  CLASS=weekly
  KEEP="${KEEP_WEEKLY}"
else
  CLASS=daily
  KEEP="${KEEP_DAILY}"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="${PREFIX}-${STAMP}.dump.age"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
TARGET="${WORKDIR}/${FILENAME}"

log "Backup ${FILENAME} (Klasse ${CLASS}, Aufbewahrung ${KEEP})"

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

# --- Rotation ---------------------------------------------------------------
# Die Dateinamen tragen einen sortierbaren UTC-Zeitstempel, deshalb genügt eine
# lexikografische Sortierung: alles ausser den jüngsten ${KEEP} fliegt raus.
mapfile -t existing < <(
  aws --endpoint-url "${BACKUP_S3_ENDPOINT}" s3 ls "${S3_BASE}/" \
    | awk '{print $4}' | grep -E "^${PREFIX}-.*\.dump\.age$" | sort
)
total="${#existing[@]}"
if [ "${total}" -gt "${KEEP}" ]; then
  obsolete=$((total - KEEP))
  log "Rotation ${CLASS}: ${total} vorhanden, ${obsolete} werden entfernt."
  for name in "${existing[@]:0:${obsolete}}"; do
    aws --endpoint-url "${BACKUP_S3_ENDPOINT}" s3 rm "${S3_BASE}/${name}"
    log "Entfernt: ${name}"
  done
else
  log "Rotation ${CLASS}: ${total} vorhanden, nichts zu entfernen."
fi

log "Backup abgeschlossen."
