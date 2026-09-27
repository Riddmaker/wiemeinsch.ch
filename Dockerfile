# syntax=docker/dockerfile:1
# Multi-Stage-Build (deps → build → ops → runner), Non-Root-Runtime.
# Node-Major bewusst gepinnt — ein Upgrade ist ein eigener Entscheid.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Prisma-Client generieren (src/generated/ ist gitignored und nicht im Build-Kontext).
RUN npx prisma generate && npm run build
# Stammdaten-Seed für den Container-Start: dieselbe prisma/seed.ts wie lokal,
# zu EINER Datei gebündelt — das Laufzeit-Image hat weder tsx noch den
# Quellcode. Der Banner stellt `require` bereit, das CommonJS-Abhängigkeiten
# (pg) im ESM-Bundle erwarten.
RUN npx esbuild prisma/seed.ts --bundle --platform=node --format=esm \
      --target=node24 --outfile=ops-dist/seed.mjs \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

# Nur die Prisma-CLI für `migrate deploy`, mit eigenem Lockfile — der
# Standalone-Build enthält sie nicht, und das ganze Root-node_modules wäre um
# ein Vielfaches grösser.
FROM node:24-alpine AS ops
WORKDIR /ops
COPY ops/package.json ops/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# `node` ist der im offiziellen Image vorhandene Non-Root-User (uid 1000).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# Werkzeuge für den Start (scripts/docker-entrypoint.sh). Bewusst root-eigen:
# Der Prozess liest Migrationen und Seed, verändert sie aber nie.
COPY --from=ops /ops/node_modules ./ops/node_modules
COPY --from=build /app/prisma.config.ts ./ops/prisma.config.ts
COPY --from=build /app/prisma/schema.prisma ./ops/prisma/schema.prisma
COPY --from=build /app/prisma/migrations ./ops/prisma/migrations
COPY --from=build /app/prisma/data ./ops/data
COPY --from=build /app/ops-dist/seed.mjs ./ops/seed.mjs
COPY --chmod=0755 scripts/docker-entrypoint.sh ./docker-entrypoint.sh
# Schema-Engine fest vorgeben statt von Prisma erkennen lassen: Jelastic legt
# eine eigene /lib/libssl.so.1.1 in den Container, Prisma schliesst daraus
# auf «musl + OpenSSL 1.1», findet dafür keine Engine und will eine
# herunterladen — als `node` ohne Schreibrecht, der Start bricht ab (erster
# Start in Produktion, 27.09.2026). Das Image selbst bringt nur OpenSSL 3 mit.
# Die Prüfung lässt schon den Build scheitern, falls ein Prisma-Upgrade die
# Datei umbenennt.
ENV PRISMA_SCHEMA_ENGINE_BINARY=/app/ops/node_modules/@prisma/engines/schema-engine-linux-musl-openssl-3.0.x
RUN test -x "$PRISMA_SCHEMA_ENGINE_BINARY"
USER node
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
