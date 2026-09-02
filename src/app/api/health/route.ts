import { prisma } from "@/lib/prisma";

// Healthcheck für Jelastic und die lokale Compose-Umgebung.
// Muss zur Laufzeit evaluieren (DB-Ping), nie beim Build statisch vorgerendert werden.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "ok" });
  } catch {
    // Kein Fehlerdetail nach aussen (P13: keine Informations-Leaks).
    return Response.json({ status: "degraded", db: "error" }, { status: 503 });
  }
}
