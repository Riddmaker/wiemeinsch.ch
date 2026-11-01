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

FROM cloudflare/cloudflared:2026.10.3@sha256:faa8e0a1475f137c910be6025f43c8e4092fdd35461b31e19fd1390657a1ff39 AS cloudflared

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
# Dieselbe Non-Root-uid wie im offiziellen Image (distroless `nonroot`).
USER 65532:65532
# Das Token kommt zur Laufzeit als TUNNEL_TOKEN aus der Umgebung des Nodes,
# nie aus dem Image. Selbst-Updates aus: Ein Upgrade ist ein neues Image.
ENTRYPOINT ["cloudflared", "--no-autoupdate"]
CMD ["tunnel", "run"]
