"use server";

import type { AppLocale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";
import { prisma } from "@/lib/prisma";
import { checkAiBudget, checkRateLimit } from "@/lib/rate-limit";
import { authenticatedUserId } from "@/lib/require-user";
import {
  publishTicketSchema,
  ticketDraftSchema,
} from "@/lib/validation/ticket";
import {
  ticketLintFields,
  type TicketLintField,
} from "@/services/content-flow";
import { lintFields, type BlockedFields } from "@/services/content-pipeline";
import { MistralUnavailableError } from "@/services/mistral";
import {
  createTicket,
  regionExists,
  translateTicketDraft,
  type TicketTranslationPreview,
} from "@/services/publish-content";

/**
 * Ticket-Publish-Flow (P7.3/P7.5) — Reihenfolge zwingend:
 * requireUser() → Rate-Limit → Zod → Civic-Linter → Mutation.
 * Fehler erreichen den Client nur als Codes, nie als rohe API-/DB-Details.
 */

export type TicketField = TicketLintField;

export type TicketLinterFields = BlockedFields<TicketField>;

/**
 * Die übersetzte Fassung für die editierbare Preview (P7.5) lebt seit P12.3
 * im geteilten Publish-Baustein — Formular und Admin-Freigabe verwenden
 * dieselbe Form.
 */
export type { TicketTranslationPreview };

export type TicketActionErrorCode =
  "unauthorized" | "rate_limited" | "invalid_input" | "ai_unavailable";

export type PrepareTicketResult =
  | {
      ok: true;
      translations: Partial<Record<AppLocale, TicketTranslationPreview>>;
    }
  | { ok: false; error: TicketActionErrorCode }
  | { ok: false; error: "linter"; fields: TicketLinterFields };

export type PublishTicketResult =
  | { ok: true; ticketId: string }
  | { ok: false; error: TicketActionErrorCode }
  | {
      ok: false;
      error: "linter";
      versions: Partial<Record<AppLocale, TicketLinterFields>>;
    };

/** Zeitfenster, in dem ein identischer Re-Submit als Doppelklick gilt (P7-Stolperstein). */
const IDEMPOTENCY_WINDOW_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schritt 1 — Original prüfen & Übersetzungen für die Preview erzeugen
// ---------------------------------------------------------------------------

export async function prepareTicketPublish(
  input: unknown,
): Promise<PrepareTicketResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  // Kostenbremse: jeder Aufruf löst mehrere Mistral-Calls aus.
  const limit = await checkRateLimit({
    scope: "ticket-prepare",
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

  const parsed = ticketDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const draft = parsed.data;

  if (!(await regionExists(draft))) {
    return { ok: false, error: "invalid_input" };
  }

  try {
    const blocked = await lintFields<TicketField>(
      ticketLintFields(draft, draft.hashtags),
      draft.locale,
      draft.locale,
    );
    if (Object.keys(blocked).length > 0) {
      return { ok: false, error: "linter", fields: blocked };
    }

    // Übersetzung Feld für Feld (parallel, Rich-Text via Markdown-Roundtrip)
    // im geteilten Baustein — identisch mit dem Weg der Admin-Freigabe (P12.3).
    return { ok: true, translations: await translateTicketDraft(draft) };
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

export async function publishTicket(
  input: unknown,
): Promise<PublishTicketResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "ticket-publish",
    identifier: userId,
    limit: 6,
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

  const parsed = publishTicketSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const data = parsed.data;

  if (!(await regionExists(data))) {
    return { ok: false, error: "invalid_input" };
  }

  // Serverseitige Idempotenz gegen Doppel-Submits: identischer Titel desselben
  // Autors innerhalb des Fensters → bestehende Ticket-ID zurückgeben.
  const recent = await prisma.ticket.findFirst({
    where: {
      authorId: userId,
      createdAt: { gt: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS) },
      translations: {
        some: { isOriginal: true, title: data.title },
      },
    },
    select: { id: true },
  });
  if (recent) {
    return { ok: true, ticketId: recent.id };
  }

  try {
    // Alle drei Fassungen durchlaufen den Linter — auch unveränderte
    // Übersetzungen sind zu diesem Zeitpunkt User-Input und werden wie
    // solcher behandelt; Hashtags nur einmal (nicht übersetzt).
    const versions: [AppLocale, ReturnType<typeof ticketLintFields>][] = [
      [data.locale, ticketLintFields(data, data.hashtags)],
    ];
    for (const locale of routing.locales) {
      const version = data.translations[locale];
      if (version) {
        versions.push([locale, ticketLintFields(version)]);
      }
    }
    const lintResults = await Promise.all(
      versions.map(
        async ([locale, fields]) =>
          [locale, await lintFields(fields, locale, data.locale)] as const,
      ),
    );
    const blockedVersions: Partial<Record<AppLocale, TicketLinterFields>> = {};
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

  // Nested create = eine Transaktion: Ticket + alle drei Sprachfassungen
  // (geteilter Baustein, P12.3).
  const ticketId = await createTicket(userId, data);

  return { ok: true, ticketId };
}
