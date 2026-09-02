import { getTranslations } from "next-intl/server";
import {
  StatementCard,
  type StatementCardData,
} from "@/components/statements/StatementCard";
import type { AppLocale } from "@/i18n/routing";
import { toAppLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { pickTranslation } from "@/lib/translations";
import type { StatementCategory } from "@/lib/validation/statement";

/**
 * Statement-Dashboard unter dem Ticket (P9.2): eine Liste, neueste zuerst.
 * Es gibt bewusst KEINE Antwort-Funktion (
 * Dashboard); die einzige Interaktion ist ▲/▼ auf der Card.
 */
export async function StatementList({
  ticketId,
  displayLocale,
  routeLocale,
  userId,
}: {
  ticketId: string;
  /** Anzeige-Sprache des Lesers (Profil-Sprache oder Routen-Locale). */
  displayLocale: AppLocale;
  /** Locale der Route — Datums-/Zahlenformat. */
  routeLocale: AppLocale;
  userId: string | null;
}) {
  const t = await getTranslations("statements");

  const statements = await prisma.statement.findMany({
    where: { ticketId, status: "PUBLISHED" },
    include: {
      translations: true,
      author: { select: { id: true, handle: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Eigene Stimmen in EINER Abfrage (kein N+1 pro Card).
  const myVotes = new Map<string, "UP" | "DOWN">();
  if (userId && statements.length > 0) {
    const rows = await prisma.statementVote.findMany({
      where: { userId, statementId: { in: statements.map((s) => s.id) } },
      select: { statementId: true, value: true },
    });
    for (const row of rows) {
      myVotes.set(row.statementId, row.value);
    }
  }

  const cards: StatementCardData[] = [];
  for (const statement of statements) {
    const version = pickTranslation(statement.translations, displayLocale);
    if (!version) {
      // Fassung fehlt (Datenfehler) — Statement überspringen statt leer rendern.
      continue;
    }
    cards.push({
      id: statement.id,
      category: statement.category as StatementCategory,
      authorId: statement.author.id,
      authorHandle: statement.author.handle,
      createdAt: statement.createdAt,
      doc: version.content,
      originalLocale: toAppLocale(statement.originalLocale),
      isTranslated: !version.isOriginal,
      upvotes: statement.upvotes,
      downvotes: statement.downvotes,
      myVote: myVotes.get(statement.id) ?? null,
    });
  }

  return (
    <section className="mt-12" data-testid="statement-dashboard">
      <h2 className="mb-4 border-b border-line pb-1.5 font-mono text-xs font-bold uppercase tracking-wide text-meta">
        {t("heading", { count: cards.length })}
      </h2>

      {cards.length === 0 ? (
        <p className="font-mono text-xs text-meta">{t("empty")}</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {cards.map((statement) => (
            <StatementCard
              key={statement.id}
              statement={statement}
              locale={routeLocale}
              isLoggedIn={userId !== null}
            />
          ))}
        </div>
      )}
    </section>
  );
}
