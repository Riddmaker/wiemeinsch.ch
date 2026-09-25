import type { Prisma } from "@/generated/prisma/client";

/**
 * Zeilensperren für die denormalisierten Zähler (Code-Review 25.09.2026).
 *
 * Befund: Vote-, Statement- und Antrags-Transaktionen zählten die Zeilen und
 * schrieben das Ergebnis danach ans Ticket. Unter READ COMMITTED (Postgres-
 * Default, Prisma setzt nichts anderes) sieht die zweite von zwei parallelen
 * Transaktionen die noch nicht committete Zeile der ersten nicht, wartet
 * beim UPDATE auf deren Sperre und überschreibt dann deren Zählung — ein
 * Vote ging verloren, bis zum nächsten Vote auf demselben Ticket. Die
 * Fremdschlüssel-Prüfung beim INSERT hilft nicht: Sie nimmt nur KEY SHARE,
 * und das kollidiert nicht mit dem Zähler-UPDATE.
 *
 * Regel: Jede Transaktion, die Ticket-Zähler neu zählt, sperrt die
 * Ticket-Zeile als ALLERERSTES — vor jedem INSERT, das auf das Ticket
 * verweist. Sonst hielten zwei Transaktionen KEY SHARE und warteten beide
 * auf FOR UPDATE (Deadlock). Reihenfolge überall: Ticket, dann Antrag bzw.
 * Statement.
 */
export async function lockTicketRow(
  tx: Prisma.TransactionClient,
  ticketId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Ticket" WHERE id = ${ticketId} FOR UPDATE`;
}

/** Gleiches Prinzip für die Vote-Zähler eines Statements. */
export async function lockStatementRow(
  tx: Prisma.TransactionClient,
  statementId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Statement" WHERE id = ${statementId} FOR UPDATE`;
}
