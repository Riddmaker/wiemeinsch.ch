#!/usr/bin/env bash
#
# Restore eines verschlüsselten Offsite-Dumps. Gegenstück zu backup.sh.
#
# Der Regelfall ist NICHT der Ernstfall, sondern der quartalsweise Restore-Test
# in die lokale Compose-Umgebung: ein Backup, das nie zurückgespielt wurde, ist
# keines. Schritt-für-Schritt-Anleitung dazu in RESTORE.md.
#
# Aufruf:
#   restore.sh --list [daily|weekly|monthly]
#   restore.sh --key daily/wiemeinsch-20260901T020000Z.dump.age
#   restore.sh --file ./wiemeinsch-20260901T020000Z.dump.age
#
# Benötigte Umgebungsvariablen:
#   BACKUP_AGE_IDENTITY   Pfad zur age-Identitätsdatei (privater Schlüssel!) —
#                         liegt NICHT in der Zielumgebung, sondern dort, wo
#                         restauriert wird (HABIT 1: Trennung der Rollen).
#   PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD   Ziel der Wiederherstellung
# Für --list und --key zusätzlich:
#   BACKUP_S3_BUCKET BACKUP_S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

set -euo pipefail

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  log "FEHLER: $*" >&2
  exit 1
}

usage() {
  sed -n '5,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

MODE=""
ARG=""
case "${1:-}" in
  --list)
    MODE=list
    ARG="${2:-}"
    ;;
  --key)
    MODE=key
    ARG="${2:?Objekt-Schlüssel fehlt}"
    ;;
  --file)
    MODE=file
    ARG="${2:?Dateipfad fehlt}"
    ;;
  --help | -h) usage 0 ;;
  *) usage 1 ;;
esac

s3() {
  : "${BACKUP_S3_BUCKET:?fehlt}" "${BACKUP_S3_ENDPOINT:?fehlt}"
  aws --endpoint-url "${BACKUP_S3_ENDPOINT}" s3 "$@"
}

if [ "${MODE}" = "list" ]; then
  for class in ${ARG:-daily weekly monthly}; do
    echo "--- ${class} ---"
    s3 ls "s3://${BACKUP_S3_BUCKET}/${class}/" | awk '{print $1, $2, $3, $4}'
  done
  exit 0
fi

: "${BACKUP_AGE_IDENTITY:?Pfad zur age-Identitätsdatei fehlt}"
[ -r "${BACKUP_AGE_IDENTITY}" ] || die "age-Identitätsdatei nicht lesbar."
: "${PGHOST:?fehlt}" "${PGUSER:?fehlt}" "${PGDATABASE:?fehlt}" "${PGPASSWORD:?fehlt}"

for tool in pg_restore age; do
  command -v "${tool}" > /dev/null || die "${tool} ist hier nicht installiert."
done

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
umask 077
ENCRYPTED="${WORKDIR}/dump.age"

if [ "${MODE}" = "key" ]; then
  log "Lade s3://${BACKUP_S3_BUCKET}/${ARG}"
  s3 cp "s3://${BACKUP_S3_BUCKET}/${ARG}" "${ENCRYPTED}"
else
  [ -r "${ARG}" ] || die "Datei ${ARG} nicht lesbar."
  cp "${ARG}" "${ENCRYPTED}"
fi

# Entschlüsselt wird in ein Verzeichnis mit umask 077 innerhalb von mktemp —
# der Klartext-Dump existiert nur für die Dauer des Restores.
DECRYPTED="${WORKDIR}/dump.pgcustom"
age --decrypt --identity "${BACKUP_AGE_IDENTITY}" --output "${DECRYPTED}" "${ENCRYPTED}"
log "Entschlüsselt: $(wc -c < "${DECRYPTED}" | tr -d ' ') Bytes"

# Inhaltsprüfung VOR dem Schreiben: pg_restore --list liest nur das
# Inhaltsverzeichnis. Schlägt das fehl, ist der Dump beschädigt — dann darf die
# Zieldatenbank gar nicht erst angefasst werden.
pg_restore --list "${DECRYPTED}" > "${WORKDIR}/toc.txt"
log "Inhaltsverzeichnis gelesen: $(wc -l < "${WORKDIR}/toc.txt" | tr -d ' ') Einträge"

log "Spiele nach ${PGDATABASE} auf ${PGHOST} zurück (bestehende Objekte werden ersetzt)."
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname "${PGDATABASE}" "${DECRYPTED}"

log "Restore abgeschlossen. Jetzt die App gegen diesen Stand starten und prüfen (RESTORE.md)."
