"use server";

import type { Prisma } from "@/generated/prisma/client";
import type { AppLocale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";
import { toDbLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { checkAiBudget, checkRateLimit } from "@/lib/rate-limit";
import { authenticatedUserId } from "@/lib/require-user";
import {
  changeRequestDraftSchema,
  declineChangeRequestSchema,
  mergeChangeRequestSchema,
  submitChangeRequestSchema,
} from "@/lib/validation/change-request";
import { plainText, type ConstrainedDoc } from "@/lib/validation/tiptap";
import { translateDoc } from "@/services/content-flow";
import { lintFields, type BlockedFields } from "@/services/content-pipeline";
import { MistralUnavailableError } from "@/services/mistral";
import { computeTicketScores } from "@/services/scoring";

/**
 * Political Pull Request (P10) — Änderungsanträge auf den Lösungstext eines
 * fremden Tickets. Gleiche Pipeline wie Tickets (P7) und Statements (P9, DRY):
 * authenticatedUserId() → Rate-Limit → Zod → Berechtigung → Civic-Linter →
 * Übersetzungs-Preview → transaktionales Speichern. Fehler erreichen den
 * Client nur als Codes, nie als Exception-Text.
 *
 * Ranking : `changeRequestCount` fliesst mit
 * Faktor 3 in E ein und wird bei jedem PPR-Ereignis aus der Tabelle GEZÄHLT
 * (selbstheilend, Muster aus P8/P9) — gezählt werden OPEN + MERGED; ein
 * abgelehnter Antrag hebt den Trending-Score nicht dauerhaft (Spam-Resistenz).
 */

export type ChangeRequestField = "solution";

export type ChangeRequestLinterFields = BlockedFields<ChangeRequestField>;

export type ChangeRequestActionErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "invalid_input"
  | "ai_unavailable"
  | "own_ticket"
  | "duplicate_open"
  | "not_author"
  | "not_open";

export type PrepareChangeRequestResult =
  | { ok: true; translations: Partial<Record<AppLocale, ConstrainedDoc>> }
  | { ok: false; error: ChangeRequestActionErrorCode }
  | { ok: false; error: "linter"; fields: ChangeRequestLinterFields };

export type SubmitChangeRequestResult =
  | { ok: true; changeRequestId: string }
  | { ok: false; error: ChangeRequestActionErrorCode }
  | {
      ok: false;
      error: "linter";
      versions: Partial<Record<AppLocale, ChangeRequestLinterFields>>;
    };

export type MergeChangeRequestResult =
  | { ok: true }
  | { ok: false; error: ChangeRequestActionErrorCode }
  | {
      ok: false;
      error: "linter";
      versions: Partial<Record<AppLocale, ChangeRequestLinterFields>>;
    };

export type DeclineChangeRequestResult =
  { ok: true } | { ok: false; error: ChangeRequestActionErrorCode };

/** Status, die als konstruktive Arbeit in den Trending-Score zählen. */
const COUNTED_STATUSES = ["OPEN", "MERGED"] as const;

/**
 * Vorprüfung für Antragsteller: Ticket muss publiziert und fremd sein, und
 * es darf kein zweiter offener Antrag desselben Users existieren
 * (Rate-Limit-Ergänzung: ein User blockiert den Autor nicht mit N Anträgen).
 */
async function checkSubmitPreconditions(
  ticketId: string,
  userId: string,
): Promise<ChangeRequestActionErrorCode | null> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { status: true, authorId: true },
  });
  if (!ticket || ticket.status !== "PUBLISHED") {
    return "invalid_input";
  }
  if (ticket.authorId === userId) {
    // 10.5: kein PPR auf das eigene Ticket.
    return "own_ticket";
  }
  const open = await prisma.changeRequest.findFirst({
    where: { ticketId, authorId: userId, status: "OPEN" },
    select: { id: true },
  });
  return open ? "duplicate_open" : null;
}

/** Lintet alle mitgelieferten Fassungen; leeres Resultat = alles sauber. */
async function lintVersions(
  versions: [AppLocale, ConstrainedDoc][],
  userLocale: AppLocale,
): Promise<Partial<Record<AppLocale, ChangeRequestLinterFields>>> {
  const results = await Promise.all(
    versions.map(
      async ([locale, doc]) =>
        [
          locale,
          await lintFields<ChangeRequestField>(
            { solution: plainText(doc) },
            locale,
            userLocale,
          ),
        ] as const,
    ),
  );
  const blocked: Partial<Record<AppLocale, ChangeRequestLinterFields>> = {};
  for (const [locale, fields] of results) {
    if (Object.keys(fields).length > 0) {
      blocked[locale] = fields;
    }
  }
  return blocked;
}

/**
 * Zähler + Scores des Tickets neu denormalisieren (Faktor 3 in E). Wird nach
 * jedem PPR-Ereignis in derselben Transaktion aufgerufen.
 */
async function refreshTicketCounters(
  tx: Prisma.TransactionClient,
  ticketId: string,
): Promise<void> {
  const ticket = await tx.ticket.findUnique({
    where: { id: ticketId },
    select: {
      upvotes: true,
      downvotes: true,
      statementCount: true,
      createdAt: true,
    },
  });
  if (!ticket) {
    return;
  }
  const changeRequestCount = await tx.changeRequest.count({
    where: { ticketId, status: { in: [...COUNTED_STATUSES] } },
  });
  await tx.ticket.update({
    where: { id: ticketId },
    data: {
      changeRequestCount,
      ...computeTicketScores({ ...ticket, changeRequestCount }),
    },
  });
}

// ---------------------------------------------------------------------------
// Schritt 1 — Vorschlag prüfen & Übersetzungen für die Preview erzeugen
// ---------------------------------------------------------------------------

export async function prepareChangeRequest(
  input: unknown,
): Promise<PrepareChangeRequestResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  // Kostenbremse: jeder Aufruf löst mehrere Mistral-Calls aus.
  const limit = await checkRateLimit({
    scope: "change-request-prepare",
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

  const parsed = changeRequestDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const draft = parsed.data;

  const blockedBy = await checkSubmitPreconditions(draft.ticketId, userId);
  if (blockedBy) {
    return { ok: false, error: blockedBy };
  }

  try {
    const blocked = await lintFields<ChangeRequestField>(
      { solution: plainText(draft.solution) },
      draft.locale,
      draft.locale,
    );
    if (Object.keys(blocked).length > 0) {
      return { ok: false, error: "linter", fields: blocked };
    }

    const translations = await translateDoc(draft.solution, draft.locale);
    return { ok: true, translations };
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      // E8 fail-closed: Einreichen blockiert, Entwurf bleibt im localStorage.
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Schritt 2 — Alle drei Fassungen prüfen & Antrag transaktional anlegen
// ---------------------------------------------------------------------------

export async function submitChangeRequest(
  input: unknown,
): Promise<SubmitChangeRequestResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "change-request-submit",
    identifier: userId,
    limit: 10,
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

  const parsed = submitChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const data = parsed.data;

  const blockedBy = await checkSubmitPreconditions(data.ticketId, userId);
  // Ein bereits offener Antrag mit identischem Text ist ein Doppel-Submit
  // (Doppelklick) — dann die bestehende Id zurückgeben statt zu meckern.
  if (blockedBy === "duplicate_open") {
    const identical = await prisma.changeRequest.findFirst({
      where: {
        ticketId: data.ticketId,
        authorId: userId,
        status: "OPEN",
        translations: {
          some: {
            isOriginal: true,
            solution: { equals: data.solution as Prisma.InputJsonValue },
          },
        },
      },
      select: { id: true },
    });
    if (identical) {
      return { ok: true, changeRequestId: identical.id };
    }
  }
  if (blockedBy) {
    return { ok: false, error: blockedBy };
  }

  try {
    // Alle drei Fassungen durchlaufen den Linter — auch unveränderte
    // Übersetzungen sind zu diesem Zeitpunkt User-Input und werden wie
    // solcher behandelt.
    const versions: [AppLocale, ConstrainedDoc][] = [
      [data.locale, data.solution],
    ];
    for (const locale of routing.locales) {
      const version = data.translations[locale];
      if (version) {
        versions.push([locale, version]);
      }
    }
    const blockedVersions = await lintVersions(versions, data.locale);
    if (Object.keys(blockedVersions).length > 0) {
      return { ok: false, error: "linter", versions: blockedVersions };
    }
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }

  const changeRequestId = await prisma.$transaction(async (tx) => {
    // Innerhalb der Transaktion erneut prüfen: zwischen Linter und Commit
    // kann sich der Ticket-Status oder die Lösung geändert haben.
    const ticket = await tx.ticket.findUnique({
      where: { id: data.ticketId },
      select: { status: true, authorId: true, solutionRevision: true },
    });
    if (
      !ticket ||
      ticket.status !== "PUBLISHED" ||
      ticket.authorId === userId
    ) {
      return null;
    }
    const openCount = await tx.changeRequest.count({
      where: { ticketId: data.ticketId, authorId: userId, status: "OPEN" },
    });
    if (openCount > 0) {
      return null;
    }

    const translationRows = [
      {
        locale: toDbLocale(data.locale),
        isOriginal: true,
        solution: data.solution,
      },
    ];
    for (const locale of routing.locales) {
      const version = data.translations[locale];
      if (version) {
        translationRows.push({
          locale: toDbLocale(locale),
          isOriginal: false,
          solution: version,
        });
      }
    }

    const created = await tx.changeRequest.create({
      data: {
        ticketId: data.ticketId,
        authorId: userId,
        originalLocale: toDbLocale(data.locale),
        // 10.4: Basis für die Stale-Erkennung beim Merge.
        baseSolutionRevision: ticket.solutionRevision,
        translations: { create: translationRows },
      },
      select: { id: true },
    });

    await refreshTicketCounters(tx, data.ticketId);
    return created.id;
  });

  if (!changeRequestId) {
    return { ok: false, error: "invalid_input" };
  }
  return { ok: true, changeRequestId };
}

// ---------------------------------------------------------------------------
// Schritt 3 — Merge / Ablehnen durch den Original-Autor
// ---------------------------------------------------------------------------

/** Gemeinsamer Berechtigungs-Guard für beide Entscheide (P10.3). */
async function loadDecidableChangeRequest(
  changeRequestId: string,
  userId: string,
): Promise<
  | { ok: true; ticketId: string; authorId: string }
  | { ok: false; error: ChangeRequestActionErrorCode }
> {
  const changeRequest = await prisma.changeRequest.findUnique({
    where: { id: changeRequestId },
    select: {
      status: true,
      authorId: true,
      ticketId: true,
      ticket: { select: { authorId: true, status: true } },
    },
  });
  if (!changeRequest || changeRequest.ticket.status !== "PUBLISHED") {
    return { ok: false, error: "invalid_input" };
  }
  if (changeRequest.ticket.authorId !== userId) {
    // Nur der Original-Autor entscheidet — Server-Bypass-Schutz (T10).
    return { ok: false, error: "not_author" };
  }
  if (changeRequest.status !== "OPEN") {
    return { ok: false, error: "not_open" };
  }
  return {
    ok: true,
    ticketId: changeRequest.ticketId,
    authorId: changeRequest.authorId,
  };
}

export async function mergeChangeRequest(
  input: unknown,
): Promise<MergeChangeRequestResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "change-request-merge",
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

  const parsed = mergeChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const data = parsed.data;

  const guard = await loadDecidableChangeRequest(data.changeRequestId, userId);
  if (!guard.ok) {
    return guard;
  }

  try {
    // Der Autor darf jede Fassung vor der Übernahme editieren — deshalb
    // laufen alle drei erneut durch den Civic-Linter (Begründungen in seiner
    // Sprache).
    const versions: [AppLocale, ConstrainedDoc][] = [];
    for (const locale of routing.locales) {
      const version = data.versions[locale];
      if (version) {
        versions.push([locale, version]);
      }
    }
    const blockedVersions = await lintVersions(versions, data.locale);
    if (Object.keys(blockedVersions).length > 0) {
      return { ok: false, error: "linter", versions: blockedVersions };
    }
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }

  const merged = await prisma.$transaction(async (tx) => {
    const changeRequest = await tx.changeRequest.findUnique({
      where: { id: data.changeRequestId },
      select: {
        status: true,
        authorId: true,
        ticketId: true,
        ticket: { select: { authorId: true, status: true } },
      },
    });
    if (
      !changeRequest ||
      changeRequest.status !== "OPEN" ||
      changeRequest.ticket.status !== "PUBLISHED" ||
      changeRequest.ticket.authorId !== userId
    ) {
      return false;
    }

    // Lösungstext in ALLEN drei Sprachfassungen ersetzen (Problem, Titel und
    // Finanzierung bleiben unberührt — ein PPR ändert nur die Lösung).
    for (const locale of routing.locales) {
      const version = data.versions[locale];
      if (!version) {
        return false;
      }
      await tx.ticketTranslation.updateMany({
        where: { ticketId: changeRequest.ticketId, locale: toDbLocale(locale) },
        data: { solution: version },
      });
    }

    await tx.ticket.update({
      where: { id: changeRequest.ticketId },
      data: {
        // 10.4: jede Lösungsänderung invalidiert die Basis offener Anträge.
        solutionRevision: { increment: 1 },
        // Proof of Stake: der Antragsteller wird Co-Autor (idempotent).
        coAuthors: { connect: { id: changeRequest.authorId } },
      },
    });

    await tx.changeRequest.update({
      where: { id: data.changeRequestId },
      data: { status: "MERGED", decidedAt: new Date() },
    });

    await refreshTicketCounters(tx, changeRequest.ticketId);
    return true;
  });

  if (!merged) {
    return { ok: false, error: "invalid_input" };
  }
  return { ok: true };
}

export async function declineChangeRequest(
  input: unknown,
): Promise<DeclineChangeRequestResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "change-request-decline",
    identifier: userId,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = declineChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }

  const guard = await loadDecidableChangeRequest(
    parsed.data.changeRequestId,
    userId,
  );
  if (!guard.ok) {
    return guard;
  }

  const declined = await prisma.$transaction(async (tx) => {
    const updated = await tx.changeRequest.updateMany({
      where: { id: parsed.data.changeRequestId, status: "OPEN" },
      data: { status: "DECLINED", decidedAt: new Date() },
    });
    if (updated.count === 0) {
      return false;
    }
    // Abgelehnte Anträge zählen nicht mehr in E — Score sinkt zurück.
    await refreshTicketCounters(tx, guard.ticketId);
    return true;
  });

  if (!declined) {
    return { ok: false, error: "not_open" };
  }
  return { ok: true };
}
