import { defineConfig, devices } from "@playwright/test";

// E2E-Tests laufen gegen die lokale Docker-Compose-Instanz.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  reporter: "list",
  // Bringt die Trending-Scores vor dem Lauf auf einen gemeinsamen Zeitpunkt
  // (Entscheid E9) — ohne das driftet die Board-Reihenfolge mit dem Seed-Alter.
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    // Ohne Aktions-Timeout (Default 0 = unbegrenzt) blockiert ein Klick auf ein
    // nie erscheinendes Element bis zum Test-Timeout — Hänger sollen als
    // konkreter Fehler an der richtigen Zeile auffallen (P10).
    actionTimeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Chromium-basiertes Mobilprofil — kein zweiter Browser-Download nötig.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
