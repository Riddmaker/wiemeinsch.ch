import { MistralError } from "@mistralai/mistralai/models/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MistralUnavailableError, withOneRetry } from "@/services/mistral";

/**
 * Retry-Stufe der Mistral-Aufrufe (Review 25.09.2026): Vorher wiederholte
 * `withOneRetry` auch bei 429 sofort — unter Last traf der zweite Versuch
 * dasselbe Limit, und der User sah «KI nicht verfügbar».
 */

function rateLimited(retryAfterSeconds?: number): MistralError {
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(retryAfterSeconds));
  }
  const response = new Response("{}", { status: 429, headers });
  return new MistralError("rate limited", {
    response,
    request: new Request("https://api.mistral.ai/v1/chat/completions"),
    body: "{}",
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withOneRetry", () => {
  it("wartet das Retry-After der API ab, bevor es erneut versucht", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rateLimited(2))
      .mockResolvedValueOnce("ok");

    const result = withOneRetry(call, "test");
    await vi.advanceTimersByTimeAsync(1_900);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("protokolliert den endgültigen Fehlschlag ohne Fehlermeldung der API", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(rateLimited());

    await expect(withOneRetry(call, "linter")).rejects.toBeInstanceOf(
      MistralUnavailableError,
    );
    const line = JSON.parse(String(errorLog.mock.calls.at(-1)?.[0])) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({
      level: "error",
      event: "mistral.failed",
      operation: "linter",
      attempts: 2,
      httpStatus: 429,
    });
    expect(JSON.stringify(line)).not.toContain("rate limited");
  });

  it("begrenzt gleichzeitige Aufrufe pro Prozess", async () => {
    let active = 0;
    let peak = 0;
    const call = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "ok";
    };
    await Promise.all(Array.from({ length: 20 }, () => withOneRetry(call)));
    expect(peak).toBeLessThanOrEqual(6);
  });
});
