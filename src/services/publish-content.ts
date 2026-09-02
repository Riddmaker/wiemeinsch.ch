import type { Prisma } from "@/generated/prisma/client";
import type { AppLocale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";
import { toDbLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { docToMarkdown } from "@/lib/tiptap-markdown";
import type { PublishStatementInput } from "@/lib/validation/statement";
import type {
  PublishTicketInput,
  TicketDraft,
  TicketTranslationVersion,
} from "@/lib/validation/ticket";
import { plainText, type ConstrainedDoc } from "@/lib/validation/tiptap";
import { requireLocale, translateDoc } from "@/services/content-flow";
import { computeTicketScores } from "@/services/scoring";
import { translateText } from "@/services/translation";

/**
 * Geteilte Publish-Bausteine (P12.3, HABIT 10): Übersetzen und Schreiben von
 * Tickets und Statements — ohne Linter, ohne Session-Logik. Genutzt von den
 * regulären Server Actions (P7/P9) UND von der Admin-Freigabe einer
 * Linter-Anfechtung (P12.2). So gibt es genau einen Schreibweg pro Inhaltstyp;
 * eine Freigabe aus der Moderations-Queue landet nicht auf einem zweiten,
 * ungetesteten Pfad.
 *
 * Bewusst OHNE "use server": das sind interne Bausteine, keine RPC-Endpunkte —
 * jede exportierte async-Funktion einer "use server"-Datei wäre vom Client
 * aufrufbar.
 */

/** Eine übersetzte Ticket-Fassung für die Preview (P7.5). */
export type TicketTranslationPreview = {
  title: string;
  problem: ConstrainedDoc;
  solution: ConstrainedDoc;
  funding?: ConstrainedDoc;
};

/**
 * Kanton/Gemeinde müssen existieren — Fremd-IDs sind sonst ein Bypass-Vektor
 * (P7.3). Auch die Linter-Anfechtung prüft das, bevor sie einen Entwurf
 * einlagert: sonst scheiterte erst die Freigabe an einem Fremdschlüssel.
 */
export async function regionExists(
  input: Pick<TicketDraft, "level" | "cantonId" | "municipalityId">,
): Promise<boolean> {
  if (input.level === "CANTONAL") {
    const canton = await prisma.canton.findUnique({
      where: { id: input.cantonId ?? -1 },
      select: { id: true },
    });
    return canton !== null;
  }
  if (input.level === "MUNICIPAL") {
    const municipality = await prisma.municipality.findUnique({
      where: { id: input.municipalityId ?? -1 },
      select: { id: true },
    });
    return municipality !== null;
  }
  return true;
}

/** Leere Finanzierungs-Editoren gelten als "nicht ausgefüllt" (Spalte bleibt NULL). */
function fundingOrNull(
  funding: TicketTranslationVersion["funding"],
): ConstrainedDoc | null {
  if (!funding || plainText(funding).trim().length === 0) {
    return null;
  }
  return funding;
}

/**
 * Übersetzt einen Ticket-Entwurf in die zwei anderen Landessprachen.
 * Wirft MistralUnavailableError (E8 fail-closed) — der Aufrufer entscheidet,
 * was das für seinen Flow bedeutet.
 */
export async function translateTicketDraft(
  draft: TicketDraft,
): Promise<Partial<Record<AppLocale, TicketTranslationPreview>>> {
  const funding =
    draft.funding && docToMarkdown(draft.funding) ? draft.funding : null;
  const [titleT, problemT, solutionT, fundingT] = await Promise.all([
    translateText({ text: draft.title, sourceLocale: draft.locale }),
    translateDoc(draft.problem, draft.locale),
    translateDoc(draft.solution, draft.locale),
    funding ? translateDoc(funding, draft.locale) : Promise.resolve(null),
  ]);

  const translations: Partial<Record<AppLocale, TicketTranslationPreview>> = {};
  for (const locale of routing.locales) {
    if (locale === draft.locale) {
      continue;
    }
    translations[locale] = {
      title: requireLocale(titleT, locale).trim(),
      problem: requireLocale(problemT, locale),
      solution: requireLocale(solutionT, locale),
      ...(fundingT ? { funding: requireLocale(fundingT, locale) } : {}),
    };
  }
  return translations;
}

function buildTicketTranslationRows(data: PublishTicketInput) {
  const rows = [
    {
      locale: toDbLocale(data.locale),
      isOriginal: true,
      title: data.title,
      problem: data.problem,
      solution: data.solution,
      ...(fundingOrNull(data.funding) ? { funding: data.funding } : {}),
    },
  ];
  for (const locale of routing.locales) {
    const version = data.translations[locale];
    if (version) {
      rows.push({
        locale: toDbLocale(locale),
        isOriginal: false,
        title: version.title,
        problem: version.problem,
        solution: version.solution,
        ...(fundingOrNull(version.funding) ? { funding: version.funding } : {}),
      });
    }
  }
  return rows;
}

/** Ticket + alle drei Sprachfassungen in einer Transaktion (nested create). */
export async function createTicket(
  authorId: string,
  data: PublishTicketInput,
): Promise<string> {
  const ticket = await prisma.ticket.create({
    data: {
      authorId,
      level: data.level,
      cantonId: data.cantonId,
      municipalityId: data.municipalityId,
      originalLocale: toDbLocale(data.locale),
      hashtags: {
        connectOrCreate: data.hashtags.map((tag) => ({
          where: { tag },
          create: { tag },
        })),
      },
      translations: { create: buildTicketTranslationRows(data) },
    },
    select: { id: true },
  });
  return ticket.id;
}

/**
 * Zählt die publizierten Statements eines Tickets neu und denormalisiert die
 * Scores (P9.4-Muster, selbstheilend). Gebraucht beim Publizieren UND beim
 * Depublizieren (P12.4) — sonst behielte ein Ticket Punkte für Inhalt, der
 * nicht mehr sichtbar ist.
 */
export async function refreshStatementAggregates(
  tx: Prisma.TransactionClient,
  ticketId: string,
): Promise<void> {
  const ticket = await tx.ticket.findUnique({
    where: { id: ticketId },
    select: {
      upvotes: true,
      downvotes: true,
      changeRequestCount: true,
      createdAt: true,
    },
  });
  if (!ticket) {
    return;
  }
  const statementCount = await tx.statement.count({
    where: { ticketId, status: "PUBLISHED" },
  });
  await tx.ticket.update({
    where: { id: ticketId },
    data: {
      statementCount,
      ...computeTicketScores({
        upvotes: ticket.upvotes,
        downvotes: ticket.downvotes,
        statementCount,
        changeRequestCount: ticket.changeRequestCount,
        createdAt: ticket.createdAt,
      }),
    },
  });
}

/**
 * Statement + Fassungen transaktional schreiben und die Ticket-Aggregate
 * nachführen. `null` = Ziel-Ticket existiert nicht (mehr) oder ist
 * depubliziert; der Aufrufer meldet das als invalid_input.
 */
export async function createStatement(
  authorId: string,
  data: PublishStatementInput,
): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: data.ticketId },
      select: { status: true },
    });
    if (!ticket || ticket.status !== "PUBLISHED") {
      return null;
    }

    const translationRows = [
      {
        locale: toDbLocale(data.locale),
        isOriginal: true,
        content: data.content,
      },
    ];
    for (const locale of routing.locales) {
      const version = data.translations[locale];
      if (version) {
        translationRows.push({
          locale: toDbLocale(locale),
          isOriginal: false,
          content: version,
        });
      }
    }

    const statement = await tx.statement.create({
      data: {
        ticketId: data.ticketId,
        authorId,
        category: data.category,
        originalLocale: toDbLocale(data.locale),
        translations: { create: translationRows },
      },
      select: { id: true },
    });

    await refreshStatementAggregates(tx, data.ticketId);
    return statement.id;
  });
}
