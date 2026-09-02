import type { AppLocale } from "@/i18n/routing";
import { prisma } from "@/lib/prisma";
import { pickTranslation } from "@/lib/translations";
import { publicUserSelect } from "@/lib/user-projection";
import {
  parseResolutionNote,
  storedAppealSchema,
  type CaseDecision,
  type QueueFilter,
  type StoredFinding,
} from "@/lib/validation/moderation";
import type { StatementCategory } from "@/lib/validation/statement";

/**
 * Lesepfade der Moderations-Queue (P12.3). Ausschliesslich für den
 * Admin-Bereich; die Seiten prüfen das Recht VOR dem Aufruf (`adminUserId()`).
 * Userdaten kommen auch hier nur über `publicUserSelect` (nDSG) — ein Admin
 * braucht für seinen Entscheid keine Demografie.
 */

export const QUEUE_PAGE_SIZE = 50;

export type CaseSummary = {
  id: string;
  type: "REPORT" | "APPEAL";
  status: "OPEN" | "RESOLVED";
  /** REPORT: Melde-Grund-Code. APPEAL: Linter-Grund-Codes, kommagetrennt. */
  reason: string;
  createdAt: Date;
  resolvedAt: Date | null;
  decision: CaseDecision | null;
  note: string | null;
  reporterId: string;
  reporterHandle: string | null;
  /** Kurzbezeichnung des betroffenen Inhalts (Titel bzw. Textanfang). */
  headline: string;
  targetKind: "ticket" | "statement" | "draft";
  /** Nur gesetzt, wenn der Inhalt publiziert existiert (verlinkbar). */
  ticketId: string | null;
  contentStatus: "PUBLISHED" | "DEPUBLISHED" | null;
};

export type ReportedTicket = {
  kind: "ticket";
  id: string;
  title: string;
  problem: unknown;
  solution: unknown;
  funding: unknown | null;
  status: "PUBLISHED" | "DEPUBLISHED";
};

export type ReportedStatement = {
  kind: "statement";
  id: string;
  ticketId: string;
  category: StatementCategory;
  doc: unknown;
  status: "PUBLISHED" | "DEPUBLISHED";
};

export type AppealedDraft = {
  kind: "draft";
  draftKind: "ticket" | "statement";
  title: string | null;
  docs: { label: string; doc: unknown }[];
  hashtags: string[];
  findings: StoredFinding[];
  /** Ticket, auf das sich ein angefochtenes Statement bezieht. */
  ticketId: string | null;
};

export type CaseDetail = CaseSummary & {
  target: ReportedTicket | ReportedStatement | AppealedDraft | null;
};

const TITLE_FALLBACK = "—";
const HEADLINE_MAX = 90;

function shorten(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > HEADLINE_MAX
    ? `${clean.slice(0, HEADLINE_MAX)}…`
    : clean;
}

/**
 * Erste Textzeile eines TipTap-Dokuments — reine Anzeige-Hilfe für die Liste.
 * Bewusst tolerant: der Inhalt ist JSON aus der DB, kein validiertes Schema.
 */
function firstText(doc: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const record = node as { text?: unknown; content?: unknown };
    if (typeof record.text === "string") {
      parts.push(record.text);
    }
    if (Array.isArray(record.content)) {
      record.content.forEach(walk);
    }
  };
  walk(doc);
  return parts.join(" ");
}

const caseSelect = {
  id: true,
  type: true,
  status: true,
  reason: true,
  createdAt: true,
  resolvedAt: true,
  resolutionNote: true,
  blockedContent: true,
  reporter: { select: publicUserSelect },
  ticket: {
    select: {
      id: true,
      status: true,
      translations: {
        select: { locale: true, title: true, isOriginal: true },
      },
    },
  },
  statement: {
    select: {
      id: true,
      status: true,
      ticketId: true,
      category: true,
      translations: {
        select: { locale: true, content: true, isOriginal: true },
      },
    },
  },
} as const;

type CaseRow = {
  id: string;
  type: "REPORT" | "APPEAL";
  status: "OPEN" | "RESOLVED";
  reason: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  blockedContent: unknown;
  reporter: { id: string; handle: string | null };
  ticket: {
    id: string;
    status: "PUBLISHED" | "DEPUBLISHED";
    translations: {
      locale: "DE" | "FR" | "IT";
      title: string;
      isOriginal: boolean;
    }[];
  } | null;
  statement: {
    id: string;
    status: "PUBLISHED" | "DEPUBLISHED";
    ticketId: string;
    category: StatementCategory;
    translations: {
      locale: "DE" | "FR" | "IT";
      content: unknown;
      isOriginal: boolean;
    }[];
  } | null;
};

function toSummary(row: CaseRow, displayLocale: AppLocale): CaseSummary {
  const { decision, note } = parseResolutionNote(row.resolutionNote);
  const appeal =
    row.type === "APPEAL"
      ? storedAppealSchema.safeParse(row.blockedContent)
      : null;

  let headline = TITLE_FALLBACK;
  let targetKind: CaseSummary["targetKind"] = "draft";
  let contentStatus: CaseSummary["contentStatus"] = null;

  if (row.type === "REPORT" && row.statement) {
    targetKind = "statement";
    contentStatus = row.statement.status;
    headline = shorten(
      firstText(
        pickTranslation(row.statement.translations, displayLocale)?.content,
      ),
    );
  } else if (row.type === "REPORT" && row.ticket) {
    targetKind = "ticket";
    contentStatus = row.ticket.status;
    headline = shorten(
      pickTranslation(row.ticket.translations, displayLocale)?.title ??
        TITLE_FALLBACK,
    );
  } else if (appeal?.success) {
    headline = shorten(
      appeal.data.kind === "ticket"
        ? appeal.data.draft.title
        : firstText(appeal.data.draft.content),
    );
  }

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    decision,
    note,
    reporterId: row.reporter.id,
    reporterHandle: row.reporter.handle,
    headline: headline || TITLE_FALLBACK,
    targetKind,
    ticketId: row.ticket?.id ?? row.statement?.ticketId ?? null,
    contentStatus,
  };
}

export async function loadModerationQueue(
  filter: QueueFilter,
  displayLocale: AppLocale,
): Promise<CaseSummary[]> {
  const rows = await prisma.moderationCase.findMany({
    where: {
      status: filter.status,
      ...(filter.type === "ALL" ? {} : { type: filter.type }),
    },
    orderBy: { createdAt: "desc" },
    take: QUEUE_PAGE_SIZE,
    select: caseSelect,
  });
  return (rows as unknown as CaseRow[]).map((row) =>
    toSummary(row, displayLocale),
  );
}

export async function countOpenCases(): Promise<number> {
  return prisma.moderationCase.count({ where: { status: "OPEN" } });
}

export async function loadModerationCase(
  caseId: string,
  displayLocale: AppLocale,
): Promise<CaseDetail | null> {
  const found = await prisma.moderationCase.findUnique({
    where: { id: caseId },
    select: caseSelect,
  });
  if (!found) {
    return null;
  }
  const row = found as unknown as CaseRow;
  const summary = toSummary(row, displayLocale);

  if (row.type === "REPORT" && row.statement) {
    return {
      ...summary,
      target: {
        kind: "statement",
        id: row.statement.id,
        ticketId: row.statement.ticketId,
        category: row.statement.category,
        doc: pickTranslation(row.statement.translations, displayLocale)
          ?.content,
        status: row.statement.status,
      },
    };
  }

  if (row.type === "REPORT" && row.ticket) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: row.ticket.id },
      select: {
        id: true,
        status: true,
        translations: {
          select: {
            locale: true,
            title: true,
            problem: true,
            solution: true,
            funding: true,
            isOriginal: true,
          },
        },
      },
    });
    const version = ticket
      ? pickTranslation(ticket.translations, displayLocale)
      : undefined;
    return {
      ...summary,
      target:
        ticket && version
          ? {
              kind: "ticket",
              id: ticket.id,
              title: version.title,
              problem: version.problem,
              solution: version.solution,
              funding: version.funding,
              status: ticket.status,
            }
          : null,
    };
  }

  const appeal = storedAppealSchema.safeParse(row.blockedContent);
  if (!appeal.success) {
    return { ...summary, target: null };
  }
  const draft = appeal.data;
  return {
    ...summary,
    target:
      draft.kind === "ticket"
        ? {
            kind: "draft",
            draftKind: "ticket",
            title: draft.draft.title,
            docs: [
              { label: "problem", doc: draft.draft.problem },
              { label: "solution", doc: draft.draft.solution },
              ...(draft.draft.funding
                ? [{ label: "funding", doc: draft.draft.funding }]
                : []),
            ],
            hashtags: draft.draft.hashtags,
            findings: draft.findings,
            ticketId: null,
          }
        : {
            kind: "draft",
            draftKind: "statement",
            title: null,
            docs: [{ label: "content", doc: draft.draft.content }],
            hashtags: [],
            findings: draft.findings,
            ticketId: draft.draft.ticketId,
          },
  };
}
