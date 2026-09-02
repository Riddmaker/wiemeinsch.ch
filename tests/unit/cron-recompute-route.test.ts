import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Zugangsschutz des Cron-Endpunkts (P15.2b). Geprüft wird das, was die Route
 * gefährlich machen würde: dass sie ohne gültigen Schlüssel rechnet, oder dass
 * sie ihre Existenz über abweichende Statuscodes verrät.
 */

const recomputeMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/scoring-recompute", () => ({
  recomputeAllTicketScores: recomputeMock,
}));

const rateLimitMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: rateLimitMock }));

import { GET, POST } from "@/app/api/cron/recompute/route";

// Wegwerf-Wert dieses Tests. Bewusst NICHT an einen Bezeichner wie
// "SECRET" oder "TOKEN" gebunden und ohne schlüsselähnliche Form: sonst schlägt
// `npm run scan:secrets` hier an, und ein Scanner, den man wegen
// Fehlalarmen lockert, findet irgendwann nichts mehr (HABIT 1).
const VALID_KEY = "cron-key-for-tests";

function post(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/cron/recompute", {
    method: "POST",
    headers,
  });
}

describe("POST /api/cron/recompute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = VALID_KEY;
    rateLimitMock.mockResolvedValue({ ok: true });
    recomputeMock.mockResolvedValue({ tickets: 28, updated: 28 });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("rechnet mit gültigem Schlüssel und meldet die Zahlen", async () => {
    const response = await POST(post({ "x-cron-key": VALID_KEY }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tickets: 28, updated: 28 });
    expect(recomputeMock).toHaveBeenCalledTimes(1);
  });

  it("ohne Schlüssel: 404 und kein Recompute", async () => {
    const response = await POST(post());

    expect(response.status).toBe(404);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("mit falschem Schlüssel: 404 und kein Recompute", async () => {
    const response = await POST(post({ "x-cron-key": "falsch" }));

    expect(response.status).toBe(404);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("ein Schlüssel, der nur das Präfix trifft, genügt nicht", async () => {
    const response = await POST(post({ "x-cron-key": VALID_KEY.slice(0, -1) }));

    expect(response.status).toBe(404);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("ohne konfiguriertes CRON_SECRET existiert die Route nicht", async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(post({ "x-cron-key": VALID_KEY }));

    expect(response.status).toBe(404);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("unberechtigt und unkonfiguriert antworten identisch — kein Orakel", async () => {
    const wrongKey = await POST(post({ "x-cron-key": "falsch" }));
    delete process.env.CRON_SECRET;
    const unconfigured = await POST(post({ "x-cron-key": VALID_KEY }));
    const viaGet = GET();

    expect(wrongKey.status).toBe(unconfigured.status);
    expect(viaGet.status).toBe(404);
    // Auch der Rumpf darf sich nicht unterscheiden.
    expect(await wrongKey.text()).toBe(await unconfigured.text());
  });

  it("über dem Fenster-Limit: 429 mit Retry-After, ohne zu rechnen", async () => {
    rateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 42 });

    const response = await POST(post({ "x-cron-key": VALID_KEY }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("prüft den Schlüssel VOR dem Rate-Limit — Unberechtigte füllen den Bucket nicht", async () => {
    await POST(post({ "x-cron-key": "falsch" }));

    expect(rateLimitMock).not.toHaveBeenCalled();
  });
});
