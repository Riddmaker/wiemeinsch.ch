-- Benachrichtigungen (E14, 04.09.2026).
--
-- Bewusst KEINE Ereignistabelle: Angezeigt werden die aktuellen Gesamtzahlen,
-- nicht Deltas. Damit genügt EIN Zeitstempel je User, um «gibt es Neues?» zu
-- beantworten — nichts muss pro Ereignis als gelesen markiert werden.
ALTER TABLE "User" ADD COLUMN "notificationsReadAt" TIMESTAMP(3);

-- Die «gibt es Neues?»-Abfrage läuft bei JEDEM Seitenaufruf im Header.
-- Ohne diese Indizes wären das drei sequentielle Scans pro Seite.
CREATE INDEX "Statement_authorId_idx" ON "Statement"("authorId");
CREATE INDEX "TicketVote_ticketId_updatedAt_idx" ON "TicketVote"("ticketId", "updatedAt");
CREATE INDEX "StatementVote_statementId_updatedAt_idx" ON "StatementVote"("statementId", "updatedAt");
