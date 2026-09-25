import type { Prisma } from "@/generated/prisma/client";
import { ACTIVE_CHANGE_REQUEST_STATUSES } from "@/lib/validation/change-request";
import { computeTicketScores } from "@/services/scoring";

/**
 * Antrags-Zähler eines Tickets neu zählen (P10, Faktor 3 in E).
 *
 * Eigener Baustein ohne "use server" (Code-Review 25.09.2026): Die Funktion
 * wird von den Antrags-Actions UND vom Depublizieren eines gemeldeten Antrags
 * gebraucht. In einer "use server"-Datei wäre jede exportierte Funktion ein
 * vom Client aufrufbarer Endpunkt.
 */

/** Status, die als konstruktive Arbeit in den Trending-Score zählen. */
export const COUNTED_CHANGE_REQUEST_STATUSES = [
  ...ACTIVE_CHANGE_REQUEST_STATUSES,
  "MERGED",
] as const;

/**
 * Zähler + Scores des Tickets neu denormalisieren. Gezählt werden laufende
 * und gemergte Anträge, die publiziert sind — abgelehnte, zurückgezogene und
 * depublizierte heben den Trending-Score nicht.
 *
 * Voraussetzung: Die Transaktion hat die Ticket-Zeile als erste Anweisung
 * gesperrt (lib/db-locks.ts).
 */
export async function refreshTicketCounters(
  tx: Prisma.TransactionClient,
  ticketId: string,
): Promise<void> {
  const ticket = await tx.ticket.findUnique({
    where: { id: ticketId },
    select: {
      upvotes: true,
      downvotes: true,
      statementCount: true,
      createdAt: true,
    },
  });
  if (!ticket) {
    return;
  }
  const changeRequestCount = await tx.changeRequest.count({
    where: {
      ticketId,
      status: { in: [...COUNTED_CHANGE_REQUEST_STATUSES] },
      contentStatus: "PUBLISHED",
    },
  });
  await tx.ticket.update({
    where: { id: ticketId },
    data: {
      changeRequestCount,
      ...computeTicketScores({ ...ticket, changeRequestCount }),
    },
  });
}
