import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken } from "@/lib/turnstile";

function mockSiteverify(
  response: { ok?: boolean; success?: boolean } | "throw",
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (response === "throw") throw new Error("network down");
      return {
        ok: response.ok ?? true,
        json: async () => ({ success: response.success ?? false }),
      } as Response;
    }),
  );
}

describe("verifyTurnstileToken (fail-closed, T4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("akzeptiert bei success=true", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    mockSiteverify({ success: true });
    expect(await verifyTurnstileToken("token")).toBe(true);
  });

  it("lehnt bei success=false ab", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    mockSiteverify({ success: false });
    expect(await verifyTurnstileToken("token")).toBe(false);
  });

  it("lehnt ohne Token ab (kein API-Call)", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await verifyTurnstileToken(null)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("lehnt ohne konfiguriertes Secret ab", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    mockSiteverify({ success: true });
    expect(await verifyTurnstileToken("token")).toBe(false);
  });

  it("lehnt bei API-Fehler/Netzwerkfehler ab", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    mockSiteverify({ ok: false, success: true });
    expect(await verifyTurnstileToken("token")).toBe(false);
    mockSiteverify("throw");
    expect(await verifyTurnstileToken("token")).toBe(false);
  });
});
