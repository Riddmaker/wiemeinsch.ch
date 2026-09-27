import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Das Tunnel-Image existiert nur, weil Jelastic das offizielle cloudflared-
 * Image (distroless, Debian 13) nicht als Custom Container annimmt
 * (27.09.2026). Dieser Test hält die Bedingungen fest, damit ein späteres
 * «Aufräumen» zurück aufs Original — oder ein Dependabot-PR auf eine andere
 * Basis — hier rot wird statt erst beim Import in Produktion.
 */

const dockerfile = readFileSync(
  path.join(process.cwd(), "tunnel", "Dockerfile"),
  "utf8",
);

const fromLines = dockerfile
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => /^FROM\s/i.test(line));

const DIGEST = /@sha256:[0-9a-f]{64}(\s|$)/;

describe("tunnel/Dockerfile", () => {
  it("baut die Laufzeit auf Alpine 3 — eine von Jelastic unterstützte Distribution", () => {
    const runtime = fromLines.at(-1) ?? "";
    expect(runtime).toMatch(/^FROM alpine:3\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it("übernimmt das Binary aus einem versions- und digest-gepinnten offiziellen Image", () => {
    const source = fromLines.find((line) =>
      line.includes("cloudflare/cloudflared"),
    );
    expect(source).toMatch(
      /^FROM cloudflare\/cloudflared:\d{4}\.\d+\.\d+@sha256:[0-9a-f]{64} AS cloudflared$/,
    );
    expect(dockerfile).toContain(
      "COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared",
    );
  });

  it("pinnt jede Basis per Digest, nie auf `latest`", () => {
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    for (const line of fromLines) {
      expect(line).toMatch(DIGEST);
      expect(line).not.toMatch(/:latest\b/);
    }
  });

  it("läuft ohne Root und ohne Selbst-Update", () => {
    const user = /^USER\s+(\S+)/m.exec(dockerfile)?.[1] ?? "";
    expect(user).not.toBe("");
    expect(user.split(":")[0]).not.toMatch(/^(0|root)$/);
    expect(dockerfile).toContain(
      'ENTRYPOINT ["cloudflared", "--no-autoupdate"]',
    );
  });

  it("enthält kein Token — das kommt zur Laufzeit aus der Umgebung", () => {
    expect(dockerfile).not.toMatch(/^\s*(ENV|ARG)\s+TUNNEL_TOKEN/m);
    expect(dockerfile).not.toMatch(/--token/);
  });
});
