-- Änderungsanträge melden und depublizieren (Code-Review 25.09.2026).
--
-- Rein additiv: eine Spalte mit Default, die bestehende Enum wird
-- wiederverwendet. Alle vorhandenen Anträge gelten als publiziert. Ab
-- PostgreSQL 11 ist ADD COLUMN mit konstantem Default ein reiner
-- Katalog-Eintrag — die Tabelle wird nicht umgeschrieben.

-- AlterTable
ALTER TABLE "ChangeRequest" ADD COLUMN     "contentStatus" "ContentStatus" NOT NULL DEFAULT 'PUBLISHED';
