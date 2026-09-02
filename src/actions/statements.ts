"use server";

import type { Prisma } from "@/generated/prisma/client";
import type { AppLocale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";
import { prisma } from "@/lib/prisma";
import { checkAiBudget, checkRateLimit } from "@/lib/rate-limit";
import { authenticatedUserId } from "@/lib/require-user";
import {
  publishStatementSchema,
  statementDraftSchema,
} from "@/lib/validation/statement";
import { plainText, type ConstrainedDoc } from "@/lib/validation/tiptap";
import { translateDoc } from "@/services/content-flow";
import { lintFields, type BlockedFields } from "@/services/content-pipeline";
import { MistralUnavailableError } from "@/services/mistral";
import { createStatement } from "@/services/publish-content";

/**
 * Statement-Publish-Flow (P9.1) — gleiche Pipeline wie Tickets (P7, DRY):
 * requireUser() → Rate-Limit → Zod → Civic-Linter → Übersetzungs-Preview →
 * transaktionales Speichern. Fehler erreichen den Client nur als Codes.
 *
 * 9.4: Beim Publizieren wird der statementCount aus der Tabelle GEZÄHLT
 * (selbstheilend, P8-Muster) und der Trending-Score des Tickets neu
 * denormalisiert (S fliesst in E ein).
 */

export type StatementField = "content";

export type StatementLinterFields = BlockedFields<StatementField>;

export type StatementActionErrorCode =
  "unauthorized" | "rate_limited" | "invalid_input" | "ai_unavailable";

export type PrepareStatementResult =
  | { ok: true; translations: Partial<Record<AppLocale, ConstrainedDoc>> }
  | { ok: false; error: StatementActionErrorCode }
  | { ok: false; error: "linter"; fields: StatementLinterFields };

export type PublishStatementResult =
  | { ok: true; statementId: string }
  | { ok: false; error: StatementActionErrorCode }
  | {
      ok: false;
      error: "linter";
      versions: Partial<Record<AppLocale, StatementLinterFields>>;
    };

/** Zeitfenster, in dem ein identischer Re-Submit als Doppelklick gilt (P7-Stolperstein). */
const IDEMPOTENCY_WINDOW_MS = 2 * 60 * 1000;

/** Fremde ticketIds sind ein Bypass-Vektor — Ziel muss publiziert existieren. */
async function ticketIsPublished(ticketId: string): Promise<boolean> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { status: true },
  });
  return ticket?.status === "PUBLISHED";
}

// ---------------------------------------------------------------------------
// Schritt 1 — Original prüfen & Übersetzungen für die Preview erzeugen
// ---------------------------------------------------------------------------

export async function prepareStatementPublish(
  input: unknown,
): Promise<PrepareStatementResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  // Kostenbremse: jeder Aufruf löst mehrere Mistral-Calls aus.
  const limit = await checkRateLimit({
    scope: "statement-prepare",
    identifier: userId,
    limit: 10,
    windowSeconds: 900,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  // Zweite Schicht: gemeinsames AI-Kostenbudget pro IP (P13.3) — ein
  // User-Limit allein liesse sich mit Wegwerf-Accounts umgehen.
  const budget = await checkAiBudget();
  if (!budget.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = statementDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const draft = parsed.data;

  if (!(await ticketIsPublished(draft.ticketId))) {
    return { ok: false, error: "invalid_input" };
  }

  try {
    const blocked = await lintFields<StatementField>(
      { content: plainText(draft.content) },
      draft.locale,
      draft.locale,
    );
    if (Object.keys(blocked).length > 0) {
      return { ok: false, error: "linter", fields: blocked };
    }

    const translations = await translateDoc(draft.content, draft.locale);
    return { ok: true, translations };
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      // E8 fail-closed: Publish blockiert, Entwurf bleibt im localStorage.
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Schritt 2 — Alle drei Fassungen prüfen & transaktional publizieren
// ---------------------------------------------------------------------------

export async function publishStatement(
  input: unknown,
): Promise<PublishStatementResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "statement-publish",
    identifier: userId,
    limit: 20,
    windowSeconds: 3600,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  // Zweite Schicht: gemeinsames AI-Kostenbudget pro IP (P13.3) — ein
  // User-Limit allein liesse sich mit Wegwerf-Accounts umgehen.
  const budget = await checkAiBudget();
  if (!budget.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = publishStatementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const data = parsed.data;

  if (!(await ticketIsPublished(data.ticketId))) {
    return { ok: false, error: "invalid_input" };
  }

  // Serverseitige Idempotenz gegen Doppel-Submits: identisches Original
  // desselben Autors auf demselben Ticket innerhalb des Fensters →
  // bestehende Statement-ID zurückgeben.
  const recent = await prisma.statement.findFirst({
    where: {
      authorId: userId,
      ticketId: data.ticketId,
      createdAt: { gt: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS) },
      translations: {
        some: {
          isOriginal: true,
          content: { equals: data.content as Prisma.InputJsonValue },
        },
      },
    },
    select: { id: true },
  });
  if (recent) {
    return { ok: true, statementId: recent.id };
  }

  try {
    // Alle drei Fassungen durchlaufen den Linter — auch unveränderte
    // Übersetzungen sind zu diesem Zeitpunkt User-Input und werden wie
    // solcher behandelt.
    const versions: [AppLocale, ConstrainedDoc][] = [
      [data.locale, data.content],
    ];
    for (const locale of routing.locales) {
      const version = data.translations[locale];
      if (version) {
        versions.push([locale, version]);
      }
    }
    const lintResults = await Promise.all(
      versions.map(
        async ([locale, doc]) =>
          [
            locale,
            await lintFields<StatementField>(
              { content: plainText(doc) },
              locale,
              data.locale,
            ),
          ] as const,
      ),
    );
    const blockedVersions: Partial<Record<AppLocale, StatementLinterFields>> =
      {};
    for (const [locale, blocked] of lintResults) {
      if (Object.keys(blocked).length > 0) {
        blockedVersions[locale] = blocked;
      }
    }
    if (Object.keys(blockedVersions).length > 0) {
      return { ok: false, error: "linter", versions: blockedVersions };
    }
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }

  // Transaktion: Statement + Fassungen schreiben und 9.4 die Ticket-Aggregate
  // (statementCount, Trending) neu zählen — geteilter Baustein (P12.3).
  const statementId = await createStatement(userId, data);

  if (!statementId) {
    return { ok: false, error: "invalid_input" };
  }
  return { ok: true, statementId };
}
