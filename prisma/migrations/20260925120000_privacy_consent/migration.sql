-- Einwilligung in die Datenschutzerklärung: Version und Zeitpunkt als Beleg.
-- Additiv; bestehende Konten haben NULL und werden beim nächsten Besuch gefragt.
ALTER TABLE "User" ADD COLUMN "privacyConsentVersion" TEXT;
ALTER TABLE "User" ADD COLUMN "privacyConsentAt" TIMESTAMP(3);
