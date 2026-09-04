import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Nur Unit-Tests — E2E (tests/e2e) läuft über Playwright, nicht Vitest.
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    environment: "node",
    /**
     * Unit-Tests dürfen die Mistral-API NIE erreichen (04.09.2026).
     *
     * Befund: Ein Test mockte `translateDoc`, die Action rief inzwischen aber
     * `translateProposal` auf — dieselbe Datei, modulinterner Aufruf, am Mock
     * vorbei. Im Container war `MISTRAL_API_KEY` gesetzt, der Test machte
     * also einen ECHTEN, kostenpflichtigen Aufruf und galt als bestanden; nur
     * auf dem Host ohne Schlüssel fiel es auf.
     *
     * Der leere Schlüssel macht daraus einen lauten Fehler: Jeder ungemockte
     * Pfad zur AI scheitert sofort mit MistralConfigError.
     */
    env: { MISTRAL_API_KEY: "" },
  },
});
