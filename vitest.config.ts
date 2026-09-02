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
  },
});
