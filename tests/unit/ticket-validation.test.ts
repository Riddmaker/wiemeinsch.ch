import { describe, expect, it } from "vitest";
import {
  publishTicketSchema,
  ticketDraftSchema,
} from "@/lib/validation/ticket";
import type { ConstrainedDoc } from "@/lib/validation/tiptap";

/** Ticket-Schemas (P7.3): Ebenen-Konsistenz + Publish-Vollständigkeit. */

const richDoc = (chars: number): ConstrainedDoc => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "x".repeat(chars) }],
    },
  ],
});

// Ein unberührter Editor liefert ein Doc ohne Inhalt (nicht: leeren Text-Node).
const emptyDoc: ConstrainedDoc = { type: "doc", content: [] };

const baseDraft = {
  locale: "de" as const,
  level: "FEDERAL" as const,
  cantonId: null,
  municipalityId: null,
  title: "Tempo 30 auf Quartierstrassen einheitlich regeln",
  hashtags: ["verkehr"],
  problem: richDoc(250),
  solution: richDoc(250),
  funding: emptyDoc,
};

const version = {
  title: "Titre traduit",
  problem: richDoc(250),
  solution: richDoc(250),
  funding: emptyDoc,
};

describe("ticketDraftSchema (P7.3)", () => {
  it("akzeptiert einen gültigen schweizweiten Entwurf", () => {
    expect(ticketDraftSchema.safeParse(baseDraft).success).toBe(true);
  });

  it("FEDERAL mit Region wird abgelehnt", () => {
    const result = ticketDraftSchema.safeParse({ ...baseDraft, cantonId: 1 });
    expect(result.success).toBe(false);
  });

  it("CANTONAL braucht cantonId und verbietet municipalityId", () => {
    expect(
      ticketDraftSchema.safeParse({ ...baseDraft, level: "CANTONAL" }).success,
    ).toBe(false);
    expect(
      ticketDraftSchema.safeParse({
        ...baseDraft,
        level: "CANTONAL",
        cantonId: 1,
      }).success,
    ).toBe(true);
    expect(
      ticketDraftSchema.safeParse({
        ...baseDraft,
        level: "CANTONAL",
        cantonId: 1,
        municipalityId: 261,
      }).success,
    ).toBe(false);
  });

  it("MUNICIPAL braucht municipalityId (ohne cantonId)", () => {
    expect(
      ticketDraftSchema.safeParse({
        ...baseDraft,
        level: "MUNICIPAL",
        municipalityId: 261,
      }).success,
    ).toBe(true);
  });

  it("Problem über 3000 Zeichen wird abgelehnt (Server-Bypass-Schutz)", () => {
    const result = ticketDraftSchema.safeParse({
      ...baseDraft,
      problem: richDoc(3001),
    });
    expect(result.success).toBe(false);
  });
});

describe("publishTicketSchema (P7.5)", () => {
  it("verlangt genau die zwei anderen Landessprachen", () => {
    expect(
      publishTicketSchema.safeParse({
        ...baseDraft,
        translations: { fr: version, it: version },
      }).success,
    ).toBe(true);
    expect(
      publishTicketSchema.safeParse({
        ...baseDraft,
        translations: { fr: version },
      }).success,
    ).toBe(false);
  });

  it("lehnt eine Übersetzung in der Originalsprache ab", () => {
    expect(
      publishTicketSchema.safeParse({
        ...baseDraft,
        translations: { fr: version, it: version, de: version },
      }).success,
    ).toBe(false);
  });
});
