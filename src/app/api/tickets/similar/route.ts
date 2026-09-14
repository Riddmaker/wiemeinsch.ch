import { getServerSession } from "next-auth";
import type { NextRequest } from "next/server";
import { z } from "@/lib/validation/zod";
import { authOptions } from "@/lib/auth";
import { toDbLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { appLocaleSchema } from "@/lib/validation/ticket";

/**
 * Duplikat-Check (P7.2): pg_trgm-Similarity
 * auf Titeln (alle Sprachfassungen) und Hashtags. Nur lesend — Mutationen
 * laufen ausschliesslich über Server Actions.
 */

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(3).max(120),
  locale: appLocaleSchema,
});

const MAX_SUGGESTIONS = 5;

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = await checkRateLimit({
    scope: "ticket-similar",
    identifier: userId,
    limit: 60,
    windowSeconds: 60,
  });
  if (!limit.ok) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = querySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? "",
    locale: request.nextUrl.searchParams.get("locale") ?? "",
  });
  if (!parsed.success) {
    return Response.json({ suggestions: [] });
  }
  const { q, locale } = parsed.data;

  // Titel-Similarity über alle Sprachfassungen (nutzt den GIN-Trigram-Index).
  const titleMatches = await prisma.$queryRaw<{ id: string; sim: number }[]>`
    SELECT tt."ticketId" AS id, MAX(similarity(tt.title, ${q}))::float AS sim
    FROM "TicketTranslation" tt
    JOIN "Ticket" t ON t.id = tt."ticketId" AND t.status = 'PUBLISHED'
    WHERE tt.title % ${q}
    GROUP BY tt."ticketId"
    ORDER BY sim DESC
    LIMIT ${MAX_SUGGESTIONS}
  `;

  // Hashtag-Similarity: Tags nahe an der Eingabe → deren Tickets.
  const tagMatches = await prisma.$queryRaw<{ tag: string }[]>`
    SELECT tag FROM "Hashtag" WHERE tag % ${q} LIMIT ${MAX_SUGGESTIONS}
  `;
  const tagTicketIds =
    tagMatches.length > 0
      ? (
          await prisma.ticket.findMany({
            where: {
              status: "PUBLISHED",
              hashtags: { some: { tag: { in: tagMatches.map((m) => m.tag) } } },
            },
            select: { id: true },
            take: MAX_SUGGESTIONS,
          })
        ).map((t) => t.id)
      : [];

  const ids = [
    ...new Set([...titleMatches.map((m) => m.id), ...tagTicketIds]),
  ].slice(0, MAX_SUGGESTIONS);
  if (ids.length === 0) {
    return Response.json({ suggestions: [] });
  }

  const tickets = await prisma.ticket.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      upvotes: true,
      downvotes: true,
      translations: {
        where: { locale: toDbLocale(locale) },
        select: { title: true },
      },
    },
  });
  const order = new Map(ids.map((id, index) => [id, index]));
  const suggestions = tickets
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((ticket) => ({
      id: ticket.id,
      title: ticket.translations[0]?.title ?? "",
      upvotes: ticket.upvotes,
      downvotes: ticket.downvotes,
    }))
    .filter((suggestion) => suggestion.title.length > 0);

  return Response.json({ suggestions });
}
