#!/bin/sh
# Start des Laufzeit-Images: erst Schema und Stammdaten, dann der Server.
#
# Warum beim Start (User-Entscheid 14.09.2026): Die Plattform kennt keine
# Release-Phase, und die Datenbank ist von aussen bewusst nicht erreichbar —
# weder aus der Pipeline noch von einem Arbeitsplatz. Der Container ist der
# einzige Ort, der die Datenbank sieht und die passenden Migrationen kennt.
# Läuft die Migration vor dem Server, arbeitet neuer Code nie gegen ein altes
# Schema.
#
# Scheitert ein Schritt, startet der Server NICHT (set -e) — lieber ein roter
# Healthcheck als eine App auf halb migriertem Schema. Deshalb gilt: nur
# additive Migrationen, und vor dem Merge einer Migration ein Backup.
set -eu

cd /app/ops

echo "[start] Datenbank-Migrationen: prisma migrate deploy"
./node_modules/.bin/prisma migrate deploy

# Idempotent: Kantone und Gemeinden aus dem BFS-Snapshot. Die Dev-Testdaten
# desselben Seeds bleiben bei NODE_ENV=production aus.
echo "[start] Stammdaten: Kantone und Gemeinden"
node seed.mjs

cd /app
exec "$@"
