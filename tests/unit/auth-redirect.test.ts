import { describe, expect, it } from "vitest";
import { authOptions } from "@/lib/auth";

const redirect = authOptions.callbacks?.redirect;
if (!redirect) throw new Error("redirect-Callback fehlt in authOptions");

const baseUrl = "http://localhost:3000";

describe("redirect-Callback (Open-Redirect-Schutz, T4)", () => {
  it("erlaubt relative Pfade", async () => {
    expect(await redirect({ url: "/de/impressum", baseUrl })).toBe(
      `${baseUrl}/de/impressum`,
    );
  });

  it("erlaubt URLs der eigenen Origin", async () => {
    expect(await redirect({ url: `${baseUrl}/fr`, baseUrl })).toBe(
      `${baseUrl}/fr`,
    );
  });

  it("normalisiert fremde Origins auf die eigene Domain", async () => {
    expect(await redirect({ url: "https://evil.example", baseUrl })).toBe(
      baseUrl,
    );
  });

  it("normalisiert unparsebare URLs", async () => {
    expect(await redirect({ url: "javascript:alert(1)", baseUrl })).toBe(
      baseUrl,
    );
  });
});
