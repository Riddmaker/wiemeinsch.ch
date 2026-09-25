#!/usr/bin/env bash
#
# GFS-Rotation der Offsite-Backups — NICHT auf dem Produktionsnode.
#
# Nur nötig, wenn das S3-Ziel keine Lifecycle-Regel bzw. kein Object Lock
# kann (siehe backup.sh: Der Node hat bewusst nur Schreibrecht). Läuft vom
# Arbeitsplatz aus, mit EIGENEN Zugangsdaten, die auflisten und löschen
# dürfen — genau die Rechte, die ein kompromittierter Node nie haben soll.
#
# Aufruf:
#   rotate.sh            zeigt, was entfernt würde (Trockenlauf, Default)
#   rotate.sh --apply    entfernt tatsächlich
#
# Benötigte Umgebungsvariablen:
#   BACKUP_S3_BUCKET BACKUP_S3_ENDPOINT
#   AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION  (List + Delete)
# Optional (mit Defaults):
#   BACKUP_KEEP_DAILY=7  BACKUP_KEEP_WEEKLY=4  BACKUP_KEEP_MONTHLY=12
#   BACKUP_PREFIX=wiemeinsch

set -euo pipefail

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
  log "FEHLER: $*" >&2
  exit 1
}

APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  "") ;;
  *) die "Unbekanntes Argument: $1 (erlaubt: --apply)" ;;
esac

PREFIX="${BACKUP_PREFIX:-wiemeinsch}"
for var in BACKUP_S3_BUCKET BACKUP_S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  # Nur der NAME wird gemeldet, nie der Wert.
  [ -n "${!var:-}" ] || die "Umgebungsvariable ${var} fehlt."
done
command -v aws > /dev/null || die "aws-CLI ist hier nicht installiert."

rotate_class() {
  local class="$1" keep="$2" base listing
  base="s3://${BACKUP_S3_BUCKET}/${class}"
  # Scheitert das Auflisten, bricht das Skript ab. Früher lief diese Liste
  # in einer Prozess-Substitution, deren Fehler `set -e` nicht sieht — mit
  # fehlenden Rechten meldete die Rotation «nichts zu entfernen».
  listing="$(aws --endpoint-url "${BACKUP_S3_ENDPOINT}" s3 ls "${base}/")" \
    || die "Auflisten von ${base}/ fehlgeschlagen."
  local -a existing=()
  while IFS= read -r name; do
    [ -n "${name}" ] && existing+=("${name}")
  done < <(printf '%s\n' "${listing}" | awk '{print $4}' \
    | grep -E "^${PREFIX}-.*\.dump\.age$" | sort || true)

  local total="${#existing[@]}"
  if [ "${total}" -le "${keep}" ]; then
    log "${class}: ${total} vorhanden, Aufbewahrung ${keep} — nichts zu entfernen."
    return
  fi
  local obsolete=$((total - keep))
  log "${class}: ${total} vorhanden, ${obsolete} über der Aufbewahrung ${keep}."
  local name
  for name in "${existing[@]:0:${obsolete}}"; do
    if [ "${APPLY}" = "1" ]; then
      aws --endpoint-url "${BACKUP_S3_ENDPOINT}" s3 rm "${base}/${name}"
      log "Entfernt: ${class}/${name}"
    else
      log "Würde entfernen: ${class}/${name}"
    fi
  done
}

rotate_class daily "${BACKUP_KEEP_DAILY:-7}"
rotate_class weekly "${BACKUP_KEEP_WEEKLY:-4}"
rotate_class monthly "${BACKUP_KEEP_MONTHLY:-12}"

[ "${APPLY}" = "1" ] || log "Trockenlauf — mit --apply wird tatsächlich entfernt."
