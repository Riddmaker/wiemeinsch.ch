-- Überarbeiten von Änderungsanträgen (E15, 14.09.2026).
--
-- Rein additiv: zwei neue Status, ein Grund-Katalog, Zeitstempel für
-- Rückgabe/Überarbeitung und die übernommene Fassung, falls der Ticket-Autor
-- den Vorschlag angepasst hat. Bestehende Anträge behalten ihren Stand
-- (mergedWithEdits = false). Ob ein früherer Merge angepasst wurde, ist nicht
-- mehr feststellbar — die alte Maske speicherte die übernommene Fassung nicht.

-- CreateEnum
CREATE TYPE "ChangeRequestReturnReason" AS ENUM ('ZU_WENIG_KONKRET', 'WEICHT_VOM_PROBLEM_AB', 'FINANZIERUNG_UNKLAR', 'ZU_UMFANGREICH', 'UEBERSETZUNG_FEHLERHAFT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ChangeRequestStatus" ADD VALUE 'CHANGES_REQUESTED';
ALTER TYPE "ChangeRequestStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "ChangeRequest" ADD COLUMN     "mergedHashtags" JSONB,
ADD COLUMN     "mergedWithEdits" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "returnReason" "ChangeRequestReturnReason",
ADD COLUMN     "returnedAt" TIMESTAMP(3),
ADD COLUMN     "revisedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ChangeRequestTranslation" ADD COLUMN     "mergedFunding" JSONB,
ADD COLUMN     "mergedProblem" JSONB,
ADD COLUMN     "mergedSolution" JSONB,
ADD COLUMN     "mergedTitle" TEXT;

-- CreateIndex
CREATE INDEX "ChangeRequest_authorId_status_idx" ON "ChangeRequest"("authorId", "status");
