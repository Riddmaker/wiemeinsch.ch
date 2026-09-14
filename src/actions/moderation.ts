"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { checkAiBudget, checkRateLimit } from "@/lib/rate-limit";
import { adminUserId } from "@/lib/require-admin";
import { authenticatedUserId } from "@/lib/require-user";
import {
  appealInputSchema,
  caseDecisionInputSchema,
  formatResolutionNote,
  reportInputSchema,
  storedAppealSchema,
  type StoredFinding,
} from "@/lib/validation/moderation";
import { publishStatementSchema } from "@/lib/validation/statement";
import { publishTicketSchema } from "@/lib/validation/ticket";
import { plainText } from "@/lib/validation/tiptap";
import { ticketLintFields, translateDoc } from "@/services/content-flow";
import { lintFields, type BlockedFields } from "@/services/content-pipeline";
import { MistralUnavailableError } from "@/services/mistral";
import {
  createStatement,
  createTicket,
  refreshStatementAggregates,
  regionExists,
  translateTicketDraft,
} from "@/services/publish-content";

/**
 * Moderation (P12) — Meldungen, Linter-Anfechtungen und die Admin-Entscheide.
 * Reihenfolge in JEDER Action zwingend:
 * Identität → Rate-Limit → Zod → Berechtigung/Zustand → Mutation.
 * Fehler erreichen den Client nur als Codes, nie als rohe DB-Details.
 *
 * Admin-Actions prüfen das Recht über `adminUserId()` (frisch aus der DB),
 * niemals über ein Feld aus dem Request — ein fehlendes Recht wird abgewiesen,
 * bevor irgendetwas geschrieben wird.
 */

export type ModerationErrorCode =
  "unauthorized" | "rate_limited" | "invalid_input" | "ai_unavailable";

export type ReportResult =
  { ok: true } | { ok: false; error: ModerationErrorCode };

export type AppealResult =
  | { ok: true; caseId: string }
  /** `not_blocked`: der Linter beanstandet den Text jetzt nicht mehr. */
  | { ok: false; error: ModerationErrorCode | "not_blocked" };

export type CaseDecisionResult =
  { ok: true } | { ok: false; error: ModerationErrorCode };

/** Zeitfenster für die Doppelklick-Erkennung (Muster aus P7/P9). */
const IDEMPOTENCY_WINDOW_MS = 2 * 60 * 1000;

/** Depublizierte Inhalte verschwinden überall — der Cache muss mit. */
function revalidateContent(): void {
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// 12.1 — Melden (REPORT)
// ---------------------------------------------------------------------------

export async function reportContent(input: unknown): Promise<ReportResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "content-report",
    identifier: userId,
    limit: 10,
    windowSeconds: 3600,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = reportInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const { targetType, targetId, reason } = parsed.data;

  // Fremde/erfundene Ids sind ein Bypass-Vektor; depublizierter Inhalt ist
  // nicht mehr meldbar (er ist bereits weg).
  const status =
    targetType === "TICKET"
      ? (
          await prisma.ticket.findUnique({
            where: { id: targetId },
            select: { status: true },
          })
        )?.status
      : (
          await prisma.statement.findUnique({
            where: { id: targetId },
            select: { status: true },
          })
        )?.status;
  if (status !== "PUBLISHED") {
    return { ok: false, error: "invalid_input" };
  }

  const target =
    targetType === "TICKET"
      ? { ticketId: targetId }
      : { statementId: targetId };

  // Zweitmeldung desselben Users auf dasselbe Ziel erzeugt keinen zweiten
  // Case — sonst liesse sich die Queue mit einem Klick fluten.
  const existing = await prisma.moderationCase.findFirst({
    where: { type: "REPORT", status: "OPEN", reporterId: userId, ...target },
    select: { id: true },
  });
  if (existing) {
    return { ok: true };
  }

  await prisma.moderationCase.create({
    data: { type: "REPORT", reporterId: userId, reason, ...target },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 12.2 — Linter-Entscheid anfechten (APPEAL)
// ---------------------------------------------------------------------------

/** Findings des Linters in die gespeicherte, feldbezogene Form bringen. */
function toStoredFindings(blocked: BlockedFields<string>): StoredFinding[] {
  const stored: StoredFinding[] = [];
  for (const [field, findings] of Object.entries(blocked)) {
    for (const finding of findings ?? []) {
      stored.push({
        field,
        reason: finding.reason,
        ...(finding.explanation ? { explanation: finding.explanation } : {}),
      });
    }
  }
  return stored;
}

export async function appealLinterDecision(
  input: unknown,
): Promise<AppealResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  // Kostenbremse: die Anfechtung lintet den Text serverseitig erneut.
  const limit = await checkRateLimit({
    scope: "linter-appeal",
    identifier: userId,
    limit: 5,
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

  const parsed = appealInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const payload = parsed.data;

  if (payload.kind === "ticket") {
    if (!(await regionExists(payload.draft))) {
      return { ok: false, error: "invalid_input" };
    }
  } else {
    const ticket = await prisma.ticket.findUnique({
      where: { id: payload.draft.ticketId },
      select: { status: true },
    });
    if (ticket?.status !== "PUBLISHED") {
      return { ok: false, error: "invalid_input" };
    }
  }

  // Der Server lintet SELBST nach: Findings vom Client wären frei erfindbar,
  // und die Queue soll nur echte Linter-Gründe zeigen (OWASP GenAI:
  // untrusted input aus dem Browser hat in einer Moderationsakte nichts
  // verloren).
  let findings: StoredFinding[];
  try {
    const blocked =
      payload.kind === "ticket"
        ? await lintFields(
            ticketLintFields(payload.draft, payload.draft.hashtags),
            payload.draft.locale,
            payload.draft.locale,
          )
        : await lintFields(
            { content: plainText(payload.draft.content) },
            payload.draft.locale,
            payload.draft.locale,
          );
    findings = toStoredFindings(blocked);
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }

  if (findings.length === 0) {
    // Nichts zu beanstanden — es gibt keinen Entscheid, der anfechtbar wäre.
    return { ok: false, error: "not_blocked" };
  }

  const reason = [...new Set(findings.map((finding) => finding.reason))].join(
    ", ",
  );
  const blockedContent = {
    kind: payload.kind,
    draft: payload.draft,
    findings,
  } as unknown as Prisma.InputJsonValue;
  const draftValue = payload.draft as unknown as Prisma.InputJsonValue;

  // Doppelklick-Schutz: identischer Entwurf, offen, derselbe User.
  const existing = await prisma.moderationCase.findFirst({
    where: {
      type: "APPEAL",
      status: "OPEN",
      reporterId: userId,
      createdAt: { gt: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS) },
      blockedContent: { path: ["draft"], equals: draftValue },
    },
    select: { id: true },
  });
  if (existing) {
    return { ok: true, caseId: existing.id };
  }

  const created = await prisma.moderationCase.create({
    data: {
      type: "APPEAL",
      reporterId: userId,
      reason,
      blockedContent,
      ...(payload.kind === "statement"
        ? { ticketId: payload.draft.ticketId }
        : {}),
    },
    select: { id: true },
  });
  return { ok: true, caseId: created.id };
}

// ---------------------------------------------------------------------------
// 12.3 — Admin-Entscheide
// ---------------------------------------------------------------------------

type DecisionContext = {
  adminId: string;
  caseId: string;
  note?: string;
};

/**
 * Gemeinsamer Vorspann jeder Admin-Action: erst Recht prüfen, dann Eingabe
 * validieren — in dieser Reihenfolge, damit ein Nicht-Admin nichts über die
 * Gültigkeit von Fall-Ids erfährt.
 *
 * Auch Admin-Actions sind rate-limitiert (P13.3): ein übernommenes
 * Admin-Konto ist der wertvollste Angriffspfad der App, und ein Limit macht
 * aus «alles depublizieren in Sekunden» ein sichtbares, langsames Ereignis
 * (OWASP A01/A04 — Least Privilege gilt auch nach oben).
 */
async function decisionContext(
  input: unknown,
): Promise<
  | { ok: true; context: DecisionContext }
  | { ok: false; error: ModerationErrorCode }
> {
  const adminId = await adminUserId();
  if (!adminId) {
    return { ok: false, error: "unauthorized" };
  }

  // Grosszügig bemessen: eine Queue-Sitzung mit vielen Fällen bleibt möglich.
  const limit = await checkRateLimit({
    scope: "moderation-decision",
    identifier: adminId,
    limit: 120,
    windowSeconds: 900,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = caseDecisionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  return {
    ok: true,
    context: {
      adminId,
      caseId: parsed.data.caseId,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    },
  };
}

/** Meldung abweisen / Anfechtung ablehnen — Inhalt bleibt, wie er ist. */
export async function dismissCase(input: unknown): Promise<CaseDecisionResult> {
  const guard = await decisionContext(input);
  if (!guard.ok) {
    return guard;
  }
  const context = guard.context;

  // updateMany mit Status-Bedingung: zwei Admins gleichzeitig entscheiden
  // nicht zweimal denselben Fall.
  const updated = await prisma.moderationCase.updateMany({
    where: { id: context.caseId, status: "OPEN" },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolutionNote: formatResolutionNote("DISMISSED", context.note),
    },
  });
  if (updated.count === 0) {
    return { ok: false, error: "invalid_input" };
  }
  revalidateContent();
  return { ok: true };
}

/**
 * Gemeldeten Inhalt depublizieren (12.4): Statusfeld statt Löschen — die Zeile
 * bleibt nachvollziehbar. Beim Statement werden die Ticket-Aggregate in
 * derselben Transaktion neu gezählt, sonst behielte das Ticket Punkte für
 * entfernten Inhalt.
 */
export async function depublishReportedContent(
  input: unknown,
): Promise<CaseDecisionResult> {
  const guard = await decisionContext(input);
  if (!guard.ok) {
    return guard;
  }
  const context = guard.context;

  const moderationCase = await prisma.moderationCase.findUnique({
    where: { id: context.caseId },
    select: { type: true, status: true, ticketId: true, statementId: true },
  });
  if (
    !moderationCase ||
    moderationCase.status !== "OPEN" ||
    moderationCase.type !== "REPORT" ||
    (!moderationCase.ticketId && !moderationCase.statementId)
  ) {
    return { ok: false, error: "invalid_input" };
  }

  await prisma.$transaction(async (tx) => {
    if (moderationCase.statementId) {
      const statement = await tx.statement.update({
        where: { id: moderationCase.statementId },
        data: { status: "DEPUBLISHED" },
        select: { ticketId: true },
      });
      await refreshStatementAggregates(tx, statement.ticketId);
    } else if (moderationCase.ticketId) {
      await tx.ticket.update({
        where: { id: moderationCase.ticketId },
        data: { status: "DEPUBLISHED" },
      });
    }
    await tx.moderationCase.update({
      where: { id: context.caseId },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolutionNote: formatResolutionNote("DEPUBLISHED", context.note),
      },
    });
  });

  revalidateContent();
  return { ok: true };
}

/**
 * Anfechtung gutheissen (User-Entscheid 30.08.2026): Der Text wird direkt aus
 * der Queue publiziert — Übersetzung läuft über denselben Baustein wie im
 * regulären Flow, der Linter wird für genau diesen Fall übersprungen, und
 * Autor bleibt die Person, die angefochten hat.
 */
export async function approveAppeal(
  input: unknown,
): Promise<CaseDecisionResult> {
  const guard = await decisionContext(input);
  if (!guard.ok) {
    return guard;
  }
  const context = guard.context;

  // Die Freigabe übersetzt den Text — sie zählt auf dasselbe AI-Budget wie
  // der reguläre Publish-Weg (P13.3).
  const budget = await checkAiBudget();
  if (!budget.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const moderationCase = await prisma.moderationCase.findUnique({
    where: { id: context.caseId },
    select: {
      type: true,
      status: true,
      reporterId: true,
      blockedContent: true,
    },
  });
  if (
    !moderationCase ||
    moderationCase.status !== "OPEN" ||
    moderationCase.type !== "APPEAL"
  ) {
    return { ok: false, error: "invalid_input" };
  }

  const appeal = storedAppealSchema.safeParse(moderationCase.blockedContent);
  if (!appeal.success) {
    return { ok: false, error: "invalid_input" };
  }

  let published: { ticketId?: string; statementId?: string };
  try {
    if (appeal.data.kind === "ticket") {
      const draft = appeal.data.draft;
      const translations = await translateTicketDraft(draft);
      const publishInput = publishTicketSchema.safeParse({
        ...draft,
        translations,
      });
      if (!publishInput.success) {
        return { ok: false, error: "invalid_input" };
      }
      published = {
        ticketId: await createTicket(
          moderationCase.reporterId,
          publishInput.data,
        ),
      };
    } else {
      const draft = appeal.data.draft;
      const translations = await translateDoc(draft.content, draft.locale);
      const publishInput = publishStatementSchema.safeParse({
        ...draft,
        translations,
      });
      if (!publishInput.success) {
        return { ok: false, error: "invalid_input" };
      }
      const statementId = await createStatement(
        moderationCase.reporterId,
        publishInput.data,
      );
      if (!statementId) {
        // Ziel-Ticket ist inzwischen weg oder depubliziert.
        return { ok: false, error: "invalid_input" };
      }
      published = { statementId };
    }
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      // E8 fail-closed: der Fall bleibt offen und kann erneut entschieden werden.
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }

  await prisma.moderationCase.update({
    where: { id: context.caseId },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolutionNote: formatResolutionNote("APPEAL_APPROVED", context.note),
      // Verweis auf den publizierten Inhalt — Nachvollziehbarkeit ohne Zusatzfeld.
      ...published,
    },
  });

  revalidateContent();
  return { ok: true };
}
