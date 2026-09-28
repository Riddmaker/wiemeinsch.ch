-- Profilbild als Identicon: nur ein Zufallswert, aus dem das Bild berechnet wird.
-- Additiv; bestehende Konten haben NULL, ihr Bild entsteht aus der User-Id.
ALTER TABLE "User" ADD COLUMN "avatarSeed" TEXT;
