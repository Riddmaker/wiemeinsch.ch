# syntax=docker/dockerfile:1
# Tunnel-Image: das offizielle cloudflared-Binary auf Alpine.
#
# Warum nicht das offizielle Image selbst: Es baut auf distroless/Debian 13
# auf (keine Shell). Jelastic nimmt als Custom Container nur Images auf
# unterstützten Distributionen an (u.a. Alpine 3, Debian 12) — der erste
# Import brach mit «unsupported OS template» ab (27.09.2026).
#
# Das Binary ist statisch gelinkt und läuft deshalb unverändert auf musl.
# Beide Basen sind per Digest gepinnt; Dependabot hebt Tag und Digest
# gemeinsam an (.github/dependabot.yml, Verzeichnis /tunnel).

FROM cloudflare/cloudflared:2026.9.3@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c AS cloudflared

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
# Dieselbe Non-Root-uid wie im offiziellen Image (distroless `nonroot`).
USER 65532:65532
# Das Token kommt zur Laufzeit als TUNNEL_TOKEN aus der Umgebung des Nodes,
# nie aus dem Image. Selbst-Updates aus: Ein Upgrade ist ein neues Image.
ENTRYPOINT ["cloudflared", "--no-autoupdate"]
CMD ["tunnel", "run"]
