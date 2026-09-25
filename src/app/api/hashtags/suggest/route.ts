import { getServerSession } from "next-auth";
import type { NextRequest } from "next/server";
import { z } from "@/lib/validation/zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Hashtag-Autocomplete (P7.1): beim Tippen
 * werden existierende Tags vorgeschlagen — Präfix-Treffer zuerst, dann
 * pg_trgm-Similarity (GIN-Index auf "Hashtag".tag).
 */

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z
    .string()
    .trim()
    .transform((value) => value.replace(/^#/, "").toLowerCase())
    .pipe(z.string().min(2).max(30))
    // Nur Zeichen, die auch hashtagSchema erlaubt — schützt zudem das
    // LIKE-Pattern vor Wildcards (%, _).
    .refine((value) => /^[\p{L}\p{N}_-]+$/u.test(value)),
});

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = await checkRateLimit({
    scope: "hashtag-suggest",
    identifier: userId,
    limit: 60,
    windowSeconds: 60,
  });
  if (!limit.ok) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = querySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? "",
  });
  if (!parsed.success) {
    return Response.json({ tags: [] });
  }
  const q = parsed.data.q;

  // Nur Tags, die noch an mindestens einem PUBLIZIERTEN Ticket hängen: Tags
  // depublizierter Tickets oder per Merge entfernte blieben sonst als
  // Vorschlag für alle sichtbar — ein Leck an der Moderation vorbei
  // (Code-Review 25.09.2026). Implizite m:n-Tabelle: A = Hashtag, B = Ticket.
  const rows = await prisma.$queryRaw<{ tag: string }[]>`
    SELECT h.tag
    FROM "Hashtag" h
    WHERE (h.tag LIKE ${`${q}%`} OR h.tag % ${q})
      AND EXISTS (
        SELECT 1
        FROM "_HashtagToTicket" ht
        JOIN "Ticket" t ON t.id = ht."B"
        WHERE ht."A" = h.id AND t.status = 'PUBLISHED'
      )
    ORDER BY (h.tag LIKE ${`${q}%`}) DESC, similarity(h.tag, ${q}) DESC, h.tag ASC
    LIMIT 8
  `;

  return Response.json({ tags: rows.map((row) => row.tag) });
}
