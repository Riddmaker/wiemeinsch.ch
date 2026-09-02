// Prisma-7-Konfiguration (ersetzt package.json#prisma; Template von `prisma init` 7.10.0).
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Seed: Stammdaten (BFS-Snapshot, Entscheid E7) + Dev-Testdaten.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
