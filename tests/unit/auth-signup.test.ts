import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Registrierung und Magic Link (Code-Review 25.09.2026):
 * - Limit pro Adresse im signIn-Callback, Schlüssel = die gemailte Adresse,
 * - strenger Normalizer (Komma-/NFKC-Varianten, Überlänge),
 * - Sprache der Registrierung statt immer DE,
 * - Mail in der Sprache der Anmeldung.
 */

const checkRateLimitMock = vi.fn();
const assignHandleMock = vi.fn();

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));
vi.mock("@/lib/handle", () => ({
  assignHandle: (...args: unknown[]) => assignHandleMock(...args),
}));

const { authOptions, MAGIC_LINK_LIMIT } = await import("@/lib/auth");
const { normalizeEmailIdentifier, EMAIL_MAX_LENGTH } =
  await import("@/lib/email-identifier");
const { localeFromAcceptLanguage, resolveSignupLocale, signupLocaleContext } =
  await import("@/lib/signup-locale");
const { buildMagicLinkMail, magicLinkLocale } =
  await import("@/lib/magic-link-mail");

beforeEach(() => {
  checkRateLimitMock.mockReset();
  assignHandleMock.mockReset();
});

describe("normalizeEmailIdentifier", () => {
  it("normalisiert Gross-/Kleinschreibung, Leerraum und NFKC", () => {
    expect(normalizeEmailIdentifier("  Anna.Muster@Example.CH ")).toBe(
      "anna.muster@example.ch",
    );
    // Vollbreite Zeichen: NFKC macht daraus dieselbe Adresse — sie darf
    // also auch nur EINEN Limit-Schlüssel ergeben.
    expect(normalizeEmailIdentifier("ａnna@example.ch")).toBe(
      "anna@example.ch",
    );
  });

  it("lässt übliche Adressen durch (Plus, Apostroph, Subdomain)", () => {
    for (const email of [
      "anna+wiemeinsch@example.ch",
      "o'brien@mail.example.co.uk",
    ]) {
      expect(normalizeEmailIdentifier(email)).toBe(email);
    }
  });

  it.each([
    "opfer@example.ch,1",
    "opfer@example.ch, x@y.ch",
    "a@b@example.ch",
    "anna muster@example.ch",
    '"anna"@example.ch',
    "anna@localhost",
    "anna@.example.ch",
    "anna@example..ch",
    "@example.ch",
    "anna@example.ch;x",
    "anna@(comment)example.ch",
    "",
  ])("lehnt %j ab", (email) => {
    expect(() => normalizeEmailIdentifier(email)).toThrow();
  });

  it("lehnt Überlängen ab, bevor sie ein Limit-Schlüssel werden", () => {
    const local = "a".repeat(EMAIL_MAX_LENGTH);
    expect(() => normalizeEmailIdentifier(`${local}@example.ch`)).toThrow();
  });
});

describe("signIn-Callback: Limit pro gemailter Adresse", () => {
  const signIn = authOptions.callbacks?.signIn;
  if (!signIn) throw new Error("signIn-Callback fehlt");

  const verification = (providerAccountId: string) =>
    signIn({
      user: { id: providerAccountId, email: providerAccountId },
      account: {
        providerAccountId,
        userId: providerAccountId,
        type: "email",
        provider: "email",
      },
      email: { verificationRequest: true },
    });

  it("zählt auf genau die Adresse, an die NextAuth mailt", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: true });
    await expect(verification("anna@example.ch")).resolves.toBe(true);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      scope: "auth-email",
      identifier: "anna@example.ch",
      ...MAGIC_LINK_LIMIT,
    });
  });

  it("leitet bei erschöpftem Limit auf die Fehlerseite um", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });
    await expect(verification("anna@example.ch")).resolves.toBe(
      "/login/error?error=RateLimit",
    );
  });

  it("zählt nicht beim Einlösen des Links und nicht bei Google", async () => {
    await expect(
      signIn({
        user: { id: "u1", email: "anna@example.ch" },
        account: {
          providerAccountId: "anna@example.ch",
          type: "email",
          provider: "email",
        },
      }),
    ).resolves.toBe(true);
    await expect(
      signIn({
        user: { id: "u1", email: "anna@example.ch" },
        account: {
          providerAccountId: "google-sub",
          type: "oauth",
          provider: "google",
        },
      }),
    ).resolves.toBe(true);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });
});

describe("Sprache der Registrierung", () => {
  const base = "http://localhost:3000/api/auth/callback/email";

  it("nimmt zuerst die callbackUrl des Magic Links", () => {
    expect(
      resolveSignupLocale({
        callbackUrl: "http://localhost:3000/fr/tickets/abc",
        callbackCookie: "http://localhost:3000/it",
        acceptLanguage: "de-CH",
        base,
      }),
    ).toBe("fr");
  });

  it("fällt auf das Callback-Cookie (Google), dann Accept-Language zurück", () => {
    expect(
      resolveSignupLocale({
        callbackUrl: null,
        callbackCookie: "http://localhost:3000/it",
        acceptLanguage: "fr-CH",
        base,
      }),
    ).toBe("it");
    expect(
      resolveSignupLocale({
        callbackUrl: "/",
        callbackCookie: undefined,
        acceptLanguage: "en-US,fr;q=0.8,de;q=0.5",
        base,
      }),
    ).toBe("fr");
    expect(
      resolveSignupLocale({
        callbackUrl: undefined,
        callbackCookie: undefined,
        acceptLanguage: undefined,
        base,
      }),
    ).toBe("de");
  });

  it("gewichtet Accept-Language korrekt und ignoriert q=0", () => {
    expect(localeFromAcceptLanguage("it;q=0, fr;q=0.4, de;q=0.9")).toBe("de");
    expect(localeFromAcceptLanguage("en, es")).toBeNull();
  });

  it("createUser setzt Handle und Sprache in einem Update", async () => {
    const createUser = authOptions.events?.createUser;
    if (!createUser) throw new Error("createUser-Event fehlt");
    await signupLocaleContext.run("fr", () =>
      createUser({ user: { id: "new-user", email: "x@example.ch" } }),
    );
    expect(assignHandleMock).toHaveBeenCalledWith("new-user", {
      preferredLocale: "FR",
    });

    await createUser({ user: { id: "other", email: "y@example.ch" } });
    expect(assignHandleMock).toHaveBeenLastCalledWith("other", {
      preferredLocale: "DE",
    });
  });
});

describe("Magic-Link-Mail", () => {
  const link = (callbackUrl: string) =>
    `http://localhost:3000/api/auth/callback/email?${new URLSearchParams({
      callbackUrl,
      token: "abc",
      email: "anna@example.ch",
    }).toString()}`;

  it("spricht die Sprache der Anmeldung", () => {
    expect(magicLinkLocale(link("http://localhost:3000/fr"))).toBe("fr");
    expect(buildMagicLinkMail(link("http://localhost:3000/it")).subject).toBe(
      "Il tuo link di accesso per wiemeinsch.ch",
    );
    expect(buildMagicLinkMail(link("http://localhost:3000/")).subject).toBe(
      "Dein Anmelde-Link für wiemeinsch.ch",
    );
  });

  it("enthält den Link in Text und HTML, im HTML maskiert", () => {
    const url = link("http://localhost:3000/de");
    const mail = buildMagicLinkMail(url);
    expect(mail.text).toContain(url);
    expect(mail.html).toContain(url.replace(/&/g, "&amp;"));
    expect(mail.html).not.toContain(`href="${url}"`);
  });
});
