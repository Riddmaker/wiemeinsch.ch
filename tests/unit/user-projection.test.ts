import { describe, expect, it } from "vitest";
import { privateUserFields, publicUserSelect } from "@/lib/user-projection";
import { Prisma } from "@/generated/prisma/client";

/**
 * Dauerhafter Regressions-Guard (nDSG, P2.5/P11.3): Die öffentliche
 * User-Projektion darf NIE ein privates Feld exponieren. Wer das Schema
 * ändert (Feld umbenennt/hinzufügt), muss diesen Test bewusst nachführen.
 */
describe("öffentliche User-Projektion", () => {
  const selectedFields = Object.keys(publicUserSelect);

  it("enthält kein einziges privates Feld", () => {
    for (const field of privateUserFields) {
      expect(selectedFields).not.toContain(field);
    }
  });

  it("privateUserFields existieren im Schema (Schutz gegen stilles Umbenennen)", () => {
    const schemaFields: string[] = Object.values(Prisma.UserScalarFieldEnum);
    for (const field of privateUserFields) {
      expect(schemaFields).toContain(field);
    }
  });

  it("neue User-Spalten müssen explizit klassifiziert werden", () => {
    // Jede Spalte des User-Modells ist entweder öffentlich (publicUserSelect),
    // explizit privat (privateUserFields) oder hier als neutral gelistet.
    // Fällt dieser Test nach einer Schema-Änderung rot aus: neue Spalte bewusst
    // einer der drei Listen zuordnen (nDSG-Review!).
    const neutralFields = ["preferredLocale", "updatedAt"];
    const classified = new Set([
      ...selectedFields,
      ...privateUserFields,
      ...neutralFields,
    ]);
    for (const field of Object.values(Prisma.UserScalarFieldEnum)) {
      expect(
        classified.has(field),
        `Unklassifizierte User-Spalte: ${field}`,
      ).toBe(true);
    }
  });
});
