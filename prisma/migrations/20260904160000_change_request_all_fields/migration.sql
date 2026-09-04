-- Änderungsanträge über alle Inhaltsfelder (E12, 04.09.2026).
--
-- Von Hand geschrieben statt generiert: Prisma hätte die umbenannten Spalten
-- DROP/ADD gemacht und damit den Revisionsstand von 41 Tickets und 47
-- Anträgen verworfen. RENAME erhält die Daten.

-- 1) Die Revision zählt neu jede Inhaltsänderung, nicht nur die Lösung.
ALTER TABLE "Ticket" RENAME COLUMN "solutionRevision" TO "contentRevision";
ALTER TABLE "ChangeRequest" RENAME COLUMN "baseSolutionRevision" TO "baseContentRevision";

-- 2) Vorgeschlagene Hashtags am Antrag (nicht übersetzt). NULL = unverändert.
ALTER TABLE "ChangeRequest" ADD COLUMN "hashtags" JSONB;

-- 3) Je Sprachfassung alle Textfelder. NULL = dieses Feld ändert der Antrag
--    nicht. Bestehende Anträge betreffen ausschliesslich die Lösung und
--    behalten damit exakt ihre bisherige Bedeutung.
ALTER TABLE "ChangeRequestTranslation" ADD COLUMN "title" TEXT;
ALTER TABLE "ChangeRequestTranslation" ADD COLUMN "problem" JSONB;
ALTER TABLE "ChangeRequestTranslation" ADD COLUMN "funding" JSONB;
ALTER TABLE "ChangeRequestTranslation" ALTER COLUMN "solution" DROP NOT NULL;
