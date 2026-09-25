"use server";

import { Prisma } from "@/generated/prisma/client";
import type { AppLocale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";
import { storedHashtags, storedProposal } from "@/lib/change-requests";
import { lockTicketRow } from "@/lib/db-locks";
import { toAppLocale, toDbLocale } from "@/lib/locale";
import { prisma } from "@/lib/prisma";
import { checkAiBudget, checkRateLimit } from "@/lib/rate-limit";
import { authenticatedUserId } from "@/lib/require-user";
import {
  ACTIVE_CHANGE_REQUEST_STATUSES,
  CHANGE_REQUEST_TEXT_FIELDS,
  changeRequestDraftSchema,
  declineChangeRequestSchema,
  mergeAdjustedChangeRequestSchema,
  mergeChangeRequestSchema,
  prepareAdjustedMergeSchema,
  returnChangeRequestSchema,
  submitChangeRequestSchema,
  withdrawChangeRequestSchema,
  type ChangeRequestProposal,
} from "@/lib/validation/change-request";
import {
  constrainedDocSchema,
  isEmptyDoc,
  type ConstrainedDoc,
} from "@/lib/validation/tiptap";
import {
  proposalLintFields,
  translateProposal,
  type TicketLintField,
} from "@/services/content-flow";
import { lintFields, type BlockedFields } from "@/services/content-pipeline";
import { MistralUnavailableError } from "@/services/mistral";
import { refreshTicketCounters } from "@/services/change-request-counters";

/**
 * Political Pull Request (P10) — Änderungsanträge auf ein fremdes Ticket.
 * Seit E12 (04.09.2026) auf ALLE Inhaltsfelder: Titel, Problem, Lösung,
 * Finanzierung und Hashtags. Jedes Feld ist einzeln änderbar; nicht
 * angefasste Felder bleiben in der Datenbank NULL. Ebene und Region sind
 * bewusst ausgenommen — sie definieren, WAS das Ticket ist, und ihre
 * nachträgliche Änderung würde abgegebene Stimmen umdeuten. Gleiche Pipeline wie Tickets (P7) und Statements (P9, DRY):
 * authenticatedUserId() → Rate-Limit → Zod → Berechtigung → Civic-Linter →
 * Übersetzungs-Preview → transaktionales Speichern. Fehler erreichen den
 * Client nur als Codes, nie als Exception-Text.
 *
 * E15 (14.09.2026) — Überarbeiten, ohne die Attribution zu verwässern:
 * - Der Ticket-Autor übernimmt 1:1 (Server nimmt die GESPEICHERTEN Fassungen),
 *   passt vor der Übernahme an (neu übersetzt; ob angepasst wurde, ermittelt
 *   der Server durch Vergleich und hält die übernommene Fassung fest), gibt
 *   mit einem Grund aus dem Katalog zur Überarbeitung zurück oder lehnt ab.
 * - Der Antragsteller überarbeitet seinen laufenden Antrag (gleiche
 *   Prepare/Submit-Actions mit `changeRequestId`) oder zieht ihn zurück.
 *
 * Ranking : `changeRequestCount` fliesst mit
 * Faktor 3 in E ein und wird bei jedem PPR-Ereignis aus der Tabelle GEZÄHLT
 * (selbstheilend, Muster aus P8/P9) — gezählt werden laufende und gemergte
 * Anträge; ein abgelehnter oder zurückgezogener Antrag hebt den
 * Trending-Score nicht dauerhaft (Spam-Resistenz).
 */

/** Feldnamen wie im Ticket-Formular — der Linter meldet sie dem Client zurück. */
export type ChangeRequestField = TicketLintField;

export type ChangeRequestLinterFields = BlockedFields<ChangeRequestField>;

export type ChangeRequestActionErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "invalid_input"
  | "ai_unavailable"
  | "own_ticket"
  | "duplicate_open"
  | "not_author"
  | "not_requester"
  | "not_open"
  | "awaiting_revision"
  | "revised"
  | "no_changes";

export type PrepareChangeRequestResult =
  | {
      ok: true;
      translations: Partial<Record<AppLocale, ChangeRequestProposal>>;
    }
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
  { ok: true } | { ok: false; error: ChangeRequestActionErrorCode };

export type PrepareAdjustedMergeResult = PrepareChangeRequestResult;

export type MergeAdjustedChangeRequestResult =
  | { ok: true }
  | { ok: false; error: ChangeRequestActionErrorCode }
  | {
      ok: false;
      error: "linter";
      versions: Partial<Record<AppLocale, ChangeRequestLinterFields>>;
    };

export type SimpleChangeRequestResult =
  { ok: true } | { ok: false; error: ChangeRequestActionErrorCode };

export type DeclineChangeRequestResult = SimpleChangeRequestResult;

/**
 * Vorprüfung für Antragsteller: Ticket muss publiziert und fremd sein.
 *
 * - Neuer Antrag: Es darf kein zweiter LAUFENDER Antrag desselben Users
 *   existieren (Rate-Limit-Ergänzung: ein User blockiert den Autor nicht mit
 *   N Anträgen).
 * - Überarbeitung (E15): Der Antrag muss zu diesem Ticket gehören, vom
 *   aufrufenden User stammen und noch laufen.
 */
async function checkSubmitPreconditions(
  ticketId: string,
  userId: string,
  changeRequestId?: string,
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
  if (changeRequestId !== undefined) {
    const own = await prisma.changeRequest.findUnique({
      where: { id: changeRequestId },
      select: {
        ticketId: true,
        authorId: true,
        status: true,
        contentStatus: true,
      },
    });
    if (!own || own.ticketId !== ticketId) {
      return "invalid_input";
    }
    if (own.authorId !== userId) {
      return "not_requester";
    }
    // Ein depublizierter Antrag (Moderation) lässt sich nicht überarbeiten.
    return isActive(own.status) && own.contentStatus !== "DEPUBLISHED"
      ? null
      : "not_open";
  }
  const open = await prisma.changeRequest.findFirst({
    where: {
      ticketId,
      authorId: userId,
      status: { in: [...ACTIVE_CHANGE_REQUEST_STATUSES] },
      contentStatus: "PUBLISHED",
    },
    select: { id: true },
  });
  return open ? "duplicate_open" : null;
}

function isActive(status: string): boolean {
  return (ACTIVE_CHANGE_REQUEST_STATUSES as readonly string[]).includes(status);
}

/** Revisionsstand aus dem Input → Wert für die DB-Bedingung. */
function revisionValue(revisedAt: string | null): Date | null {
  return revisedAt === null ? null : new Date(revisedAt);
}

/** Hat der Antragsteller seit dem angezeigten Stand überarbeitet? */
function isRevisedSince(
  stored: Date | null,
  seenRevisedAt: string | null,
): boolean {
  return (
    (stored?.getTime() ?? null) !==
    (revisionValue(seenRevisedAt)?.getTime() ?? null)
  );
}

/**
 * Warum ein Claim nichts beansprucht hat: Ist der Antrag noch offen, wurde er
 * in der Zwischenzeit überarbeitet (`revised`), sonst ist er entschieden.
 */
async function claimFailure(
  client: Pick<Prisma.TransactionClient, "changeRequest">,
  changeRequestId: string,
): Promise<ChangeRequestActionErrorCode> {
  const current = await client.changeRequest.findUnique({
    where: { id: changeRequestId },
    select: { status: true, contentStatus: true },
  });
  return current?.status === "OPEN" && current.contentStatus !== "DEPUBLISHED"
    ? "revised"
    : "not_open";
}

/**
 * Lintet alle mitgelieferten Fassungen; leeres Resultat = alles sauber.
 * Geprüft wird je Fassung genau das, was sie ändert (E12) — Hashtags nur an
 * der Original-Fassung, weil sie nicht übersetzt werden.
 */
async function lintVersions(
  versions: [AppLocale, ChangeRequestProposal, string[] | undefined][],
  userLocale: AppLocale,
): Promise<Partial<Record<AppLocale, ChangeRequestLinterFields>>> {
  const results = await Promise.all(
    versions.map(
      async ([locale, proposal, hashtags]) =>
        [
          locale,
          await lintFields<ChangeRequestField>(
            proposalLintFields(proposal, hashtags),
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

/** Original + Übersetzungen als Lint-Liste; Hashtags nur am Original. */
function versionList(
  locale: AppLocale,
  original: ChangeRequestProposal,
  hashtags: string[] | undefined,
  translations: Partial<Record<AppLocale, ChangeRequestProposal>>,
): [AppLocale, ChangeRequestProposal, string[] | undefined][] {
  const versions: [AppLocale, ChangeRequestProposal, string[] | undefined][] = [
    [locale, original, hashtags],
  ];
  for (const target of routing.locales) {
    const version = translations[target];
    if (version && target !== locale) {
      versions.push([target, version, undefined]);
    }
  }
  return versions;
}

/** Nur die Vorschlagsfelder aus einer validierten Eingabe herausziehen. */
function toProposal(input: {
  title?: string;
  problem?: ConstrainedDoc;
  solution?: ConstrainedDoc;
  funding?: ConstrainedDoc;
}): ChangeRequestProposal {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.problem !== undefined ? { problem: input.problem } : {}),
    ...(input.solution !== undefined ? { solution: input.solution } : {}),
    ...(input.funding !== undefined ? { funding: input.funding } : {}),
  };
}

/** Zwei TipTap-Dokumente inhaltsgleich? Beide Seiten laufen vorher durch
 * dasselbe Schema, damit die Schlüsselreihenfolge normalisiert ist. */
function sameDoc(a: unknown, b: unknown): boolean {
  const parsedA = constrainedDocSchema.safeParse(a);
  const parsedB = constrainedDocSchema.safeParse(b);
  if (!parsedA.success || !parsedB.success) {
    return false;
  }
  return JSON.stringify(parsedA.data) === JSON.stringify(parsedB.data);
}

function sameHashtags(a: string[], b: string[]): boolean {
  return [...a].sort().join(" ") === [...b].sort().join(" ");
}

/** Gleiche Felder mit gleichem Inhalt? (E15: Anpassung erkannt?) */
function sameProposal(
  a: ChangeRequestProposal,
  b: ChangeRequestProposal,
): boolean {
  if (a.title !== b.title) {
    return false;
  }
  for (const field of ["problem", "solution", "funding"] as const) {
    if ((a[field] === undefined) !== (b[field] === undefined)) {
      return false;
    }
    if (a[field] !== undefined && !sameDoc(a[field], b[field])) {
      return false;
    }
  }
  return true;
}

/** Welche Textfelder trägt ein Vorschlag? */
function fieldSet(proposal: ChangeRequestProposal): string {
  return CHANGE_REQUEST_TEXT_FIELDS.filter(
    (field) => proposal[field] !== undefined,
  ).join(",");
}

/** Proposal-Felder als DB-Zeile — nicht angefasste Felder bleiben NULL. */
function proposalRow(proposal: ChangeRequestProposal) {
  return {
    ...(proposal.title !== undefined ? { title: proposal.title } : {}),
    ...(proposal.problem !== undefined ? { problem: proposal.problem } : {}),
    ...(proposal.solution !== undefined ? { solution: proposal.solution } : {}),
    ...(proposal.funding !== undefined ? { funding: proposal.funding } : {}),
  };
}

/**
 * Ändert der Antrag überhaupt etwas? (E12)
 *
 * Ein Formular, das alle Felder vorbefüllt zurückschickt, erzeugte sonst
 * einen Antrag ohne Vorschlag — der Autor müsste über einen leeren Diff
 * entscheiden, und der Trending-Score stiege für nichts.
 */
async function proposalChangesAnything(
  ticketId: string,
  locale: AppLocale,
  proposal: ChangeRequestProposal,
  hashtags: string[] | undefined,
): Promise<boolean> {
  const current = await prisma.ticketTranslation.findUnique({
    where: { ticketId_locale: { ticketId, locale: toDbLocale(locale) } },
    select: { title: true, problem: true, solution: true, funding: true },
  });
  if (!current) {
    return false;
  }
  if (proposal.title !== undefined && proposal.title !== current.title) {
    return true;
  }
  for (const field of ["problem", "solution", "funding"] as const) {
    const proposed = proposal[field];
    if (proposed === undefined) {
      continue;
    }
    // Eine leere Finanzierung auf einem Ticket ohne Finanzierung ändert nichts.
    if (field === "funding" && isEmptyDoc(proposed) && !current.funding) {
      continue;
    }
    if (!sameDoc(proposed, current[field])) {
      return true;
    }
  }
  if (hashtags !== undefined) {
    const rows = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { hashtags: { select: { tag: true } } },
    });
    if (
      rows &&
      !sameHashtags(
        hashtags,
        rows.hashtags.map((h) => h.tag),
      )
    ) {
      return true;
    }
  }
  return false;
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

  // Kostenbremse: jeder Aufruf löst mehrere Mistral-Calls aus. Überarbeitungen
  // (E15) teilen sich dieses Budget — sonst liesse sich über Bearbeiten-
  // Schleifen beliebig übersetzen.
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

  const blockedBy = await checkSubmitPreconditions(
    draft.ticketId,
    userId,
    draft.changeRequestId,
  );
  if (blockedBy) {
    return { ok: false, error: blockedBy };
  }

  const { locale, hashtags } = draft;
  const proposal = toProposal(draft);

  // Ein Antrag, der nichts ändert, ist keiner — vor den teuren AI-Calls prüfen.
  if (
    !(await proposalChangesAnything(draft.ticketId, locale, proposal, hashtags))
  ) {
    return { ok: false, error: "no_changes" };
  }

  try {
    const blocked = await lintFields<ChangeRequestField>(
      proposalLintFields(proposal, hashtags),
      locale,
      locale,
    );
    if (Object.keys(blocked).length > 0) {
      return { ok: false, error: "linter", fields: blocked };
    }

    const translations = await translateProposal(proposal, locale);
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
// (bzw. einen eigenen laufenden Antrag ersetzen, E15)
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
  const revisionId = data.changeRequestId;

  const blockedBy = await checkSubmitPreconditions(
    data.ticketId,
    userId,
    revisionId,
  );
  // Ein bereits offener Antrag mit identischem Inhalt ist ein Doppel-Submit
  // (Doppelklick) — dann die bestehende Id zurückgeben statt zu meckern.
  // Identisch heisst: ALLE Felder und die Hashtags. Vorher verglich die
  // Prüfung nur Titel, Problem und Lösung; ein anderer zweiter Antrag (etwa
  // aus einem alten Tab) meldete dann «ok» mit der alten Id, und der Client
  // verwarf den neuen Text samt Entwurf (Code-Review 25.09.2026).
  if (blockedBy === "duplicate_open") {
    const open = await prisma.changeRequest.findFirst({
      where: { ticketId: data.ticketId, authorId: userId, status: "OPEN" },
      select: {
        id: true,
        originalLocale: true,
        hashtags: true,
        translations: {
          where: { isOriginal: true },
          select: { title: true, problem: true, solution: true, funding: true },
        },
      },
    });
    const storedOriginal = open?.translations[0];
    const storedTags = open ? storedHashtags(open.hashtags) : undefined;
    if (
      open &&
      storedOriginal &&
      toAppLocale(open.originalLocale) === data.locale &&
      sameProposal(storedProposal(storedOriginal), toProposal(data)) &&
      (storedTags === undefined) === (data.hashtags === undefined) &&
      sameHashtags(storedTags ?? [], data.hashtags ?? [])
    ) {
      return { ok: true, changeRequestId: open.id };
    }
  }
  if (blockedBy) {
    return { ok: false, error: blockedBy };
  }

  const { locale, hashtags, translations } = data;
  const original = toProposal(data);

  // Auch hier prüfen: Schritt 1 lässt sich am Client überspringen.
  if (
    !(await proposalChangesAnything(data.ticketId, locale, original, hashtags))
  ) {
    return { ok: false, error: "no_changes" };
  }

  try {
    // Alle drei Fassungen durchlaufen den Linter — auch unveränderte
    // Übersetzungen sind zu diesem Zeitpunkt User-Input und werden wie
    // solcher behandelt.
    const blockedVersions = await lintVersions(
      versionList(locale, original, hashtags, translations),
      locale,
    );
    if (Object.keys(blockedVersions).length > 0) {
      return { ok: false, error: "linter", versions: blockedVersions };
    }
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }

  const translationRows = [
    { locale: toDbLocale(locale), isOriginal: true, ...proposalRow(original) },
  ];
  for (const target of routing.locales) {
    const version = translations[target];
    if (version && target !== locale) {
      translationRows.push({
        locale: toDbLocale(target),
        isOriginal: false,
        ...proposalRow(version),
      });
    }
  }

  const changeRequestId = await prisma.$transaction(async (tx) => {
    // Sperre zuerst (Ticket vor Antrag, lib/db-locks.ts).
    await lockTicketRow(tx, data.ticketId);
    // Innerhalb der Transaktion erneut prüfen: zwischen Linter und Commit
    // kann sich der Ticket-Status oder die Lösung geändert haben.
    const ticket = await tx.ticket.findUnique({
      where: { id: data.ticketId },
      select: { status: true, authorId: true, contentRevision: true },
    });
    if (
      !ticket ||
      ticket.status !== "PUBLISHED" ||
      ticket.authorId === userId
    ) {
      return null;
    }

    if (revisionId !== undefined) {
      // E15 Überarbeitung: ZUERST den Antrag atomar beanspruchen — die
      // Bedingung (eigener, laufender Antrag auf diesem Ticket) steckt im
      // UPDATE selbst. Die Zeilensperre hält bis zum Commit, ein parallel
      // laufender Merge kann den Antrag also nicht mit dem alten Text
      // übernehmen, während er hier ersetzt wird.
      const claimed = await tx.changeRequest.updateMany({
        where: {
          id: revisionId,
          ticketId: data.ticketId,
          authorId: userId,
          status: { in: [...ACTIVE_CHANGE_REQUEST_STATUSES] },
          contentStatus: "PUBLISHED",
        },
        data: {
          status: "OPEN",
          originalLocale: toDbLocale(locale),
          // Neue Basis: überarbeitet wurde gegen den aktuellen Stand.
          baseContentRevision: ticket.contentRevision,
          hashtags: hashtags ?? Prisma.DbNull,
          returnReason: null,
          returnedAt: null,
          revisedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        return null;
      }
      await tx.changeRequestTranslation.deleteMany({
        where: { changeRequestId: revisionId },
      });
      await tx.changeRequestTranslation.createMany({
        data: translationRows.map((row) => ({
          ...row,
          changeRequestId: revisionId,
        })),
      });
      await refreshTicketCounters(tx, data.ticketId);
      return revisionId;
    }

    const openCount = await tx.changeRequest.count({
      where: {
        ticketId: data.ticketId,
        authorId: userId,
        status: { in: [...ACTIVE_CHANGE_REQUEST_STATUSES] },
        contentStatus: "PUBLISHED",
      },
    });
    if (openCount > 0) {
      return null;
    }

    const created = await tx.changeRequest.create({
      data: {
        ticketId: data.ticketId,
        authorId: userId,
        originalLocale: toDbLocale(locale),
        // 10.4: Basis für die Stale-Erkennung beim Merge.
        baseContentRevision: ticket.contentRevision,
        ...(hashtags !== undefined ? { hashtags } : {}),
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
// Schritt 3 — Entscheide des Ticket-Autors
// ---------------------------------------------------------------------------

type DecidableStatus = (typeof ACTIVE_CHANGE_REQUEST_STATUSES)[number];

/**
 * Gemeinsamer Berechtigungs-Guard für alle Entscheide (P10.3). `allowed`
 * nennt die Status, aus denen der Entscheid möglich ist — ein Antrag in
 * Überarbeitung (E15) lässt sich nur noch ablehnen, nicht übernehmen oder
 * erneut zurückgeben: Sonst überholte der Autor die laufende Bearbeitung.
 */
async function loadDecidableChangeRequest(
  changeRequestId: string,
  userId: string,
  allowed: readonly DecidableStatus[],
  /** Gesehener Revisionsstand; `undefined` = Entscheid ohne Inhaltsbezug. */
  seenRevisedAt?: string | null,
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
      revisedAt: true,
      contentStatus: true,
      ticket: { select: { authorId: true, status: true } },
    },
  });
  if (
    !changeRequest ||
    changeRequest.ticket.status !== "PUBLISHED" ||
    changeRequest.contentStatus === "DEPUBLISHED"
  ) {
    return { ok: false, error: "invalid_input" };
  }
  if (changeRequest.ticket.authorId !== userId) {
    // Nur der Original-Autor entscheidet — Server-Bypass-Schutz (T10).
    return { ok: false, error: "not_author" };
  }
  if (!(allowed as readonly string[]).includes(changeRequest.status)) {
    return {
      ok: false,
      error:
        changeRequest.status === "CHANGES_REQUESTED"
          ? "awaiting_revision"
          : "not_open",
    };
  }
  if (
    seenRevisedAt !== undefined &&
    isRevisedSince(changeRequest.revisedAt ?? null, seenRevisedAt)
  ) {
    // Der Autor würde über eine Fassung entscheiden, die er nicht gesehen hat.
    return { ok: false, error: "revised" };
  }
  return {
    ok: true,
    ticketId: changeRequest.ticketId,
    authorId: changeRequest.authorId,
  };
}

/** Gespeicherter Antrag mit allen Fassungen, wie ihn beide Merge-Wege brauchen. */
async function loadStoredVersions(changeRequestId: string): Promise<{
  versions: Record<AppLocale, ChangeRequestProposal>;
  hashtags: string[] | undefined;
} | null> {
  const row = await prisma.changeRequest.findUnique({
    where: { id: changeRequestId },
    select: {
      hashtags: true,
      translations: {
        select: {
          locale: true,
          title: true,
          problem: true,
          solution: true,
          funding: true,
        },
      },
    },
  });
  if (!row) {
    return null;
  }
  const versions: Partial<Record<AppLocale, ChangeRequestProposal>> = {};
  for (const item of row.translations) {
    versions[toAppLocale(item.locale)] = storedProposal(item);
  }
  if (routing.locales.some((locale) => !versions[locale])) {
    // Datenfehler: ohne alle drei Fassungen würde das Ticket auseinanderlaufen.
    return null;
  }
  return {
    versions: versions as Record<AppLocale, ChangeRequestProposal>,
    hashtags: storedHashtags(row.hashtags),
  };
}

/**
 * Schreibt einen Merge transaktional (P10.3, geteilt von beiden Merge-Wegen).
 *
 * `edited` = die übernommene Fassung weicht vom gespeicherten Vorschlag ab
 * (E15). Dann wird sie neben dem Vorschlag festgehalten, damit die Anzeige
 * zeigen kann, was vom Antragsteller stammt und was der Autor angepasst hat.
 */
async function applyMerge(args: {
  changeRequestId: string;
  userId: string;
  /** Revisionsstand, den der Autor gesehen hat — Teil des Claims. */
  seenRevisedAt: string | null;
  versions: Record<AppLocale, ChangeRequestProposal>;
  hashtags: string[] | undefined;
  edited: boolean;
}): Promise<ChangeRequestActionErrorCode | null> {
  const { changeRequestId, userId, seenRevisedAt, versions, hashtags, edited } =
    args;

  return prisma.$transaction(async (tx) => {
    const changeRequest = await tx.changeRequest.findUnique({
      where: { id: changeRequestId },
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
      return "invalid_input";
    }
    // Ticket vor Antrag sperren — dieselbe Reihenfolge wie beim Einreichen
    // einer Überarbeitung, sonst könnten sich beide gegenseitig blockieren.
    await lockTicketRow(tx, changeRequest.ticketId);

    // Atomar beanspruchen, BEVOR das Ticket angefasst wird — und nur, wenn
    // der Antrag noch die Fassung trägt, die der Autor gesehen hat. Eine
    // zwischenzeitliche Überarbeitung (E15) setzt `revisedAt` neu und lässt
    // den Claim leer ausgehen; ein zweiter Klick findet den Antrag nicht mehr
    // offen vor. Erst diese Bedingung macht das Lesen der Fassungen vor der
    // Transaktion sicher: Ändern kann sie nur eine Überarbeitung.
    const claimed = await tx.changeRequest.updateMany({
      where: {
        id: changeRequestId,
        status: "OPEN",
        contentStatus: "PUBLISHED",
        revisedAt: revisionValue(seenRevisedAt),
      },
      data: {
        status: "MERGED",
        decidedAt: new Date(),
        mergedWithEdits: edited,
        ...(edited && hashtags !== undefined
          ? { mergedHashtags: hashtags }
          : {}),
      },
    });
    if (claimed.count === 0) {
      return claimFailure(tx, changeRequestId);
    }

    // Nur die Felder ersetzen, die der Antrag tatsächlich vorschlägt (E12) —
    // ein Antrag auf den Titel darf die Lösung nicht anfassen.
    for (const locale of routing.locales) {
      const patch: Prisma.TicketTranslationUpdateManyMutationInput =
        proposalRow(versions[locale]);
      if (Object.keys(patch).length === 0) {
        continue;
      }
      // Ein leeres Finanzierungsfeld im Antrag heisst «Finanzierung
      // entfernen». Am Antrag bleibt das leere Dokument als Markierung stehen
      // (NULL hiesse dort «unverändert»); am Ticket wird daraus NULL wie beim
      // Erstellen — sonst zeigte die Seite eine leere Überschrift.
      if (versions[locale].funding && isEmptyDoc(versions[locale].funding)) {
        patch.funding = Prisma.DbNull;
      }
      await tx.ticketTranslation.updateMany({
        where: { ticketId: changeRequest.ticketId, locale: toDbLocale(locale) },
        data: patch,
      });
      if (edited) {
        const version = versions[locale];
        await tx.changeRequestTranslation.updateMany({
          where: { changeRequestId, locale: toDbLocale(locale) },
          data: {
            ...(version.title !== undefined
              ? { mergedTitle: version.title }
              : {}),
            ...(version.problem !== undefined
              ? { mergedProblem: version.problem }
              : {}),
            ...(version.solution !== undefined
              ? { mergedSolution: version.solution }
              : {}),
            ...(version.funding !== undefined
              ? { mergedFunding: version.funding }
              : {}),
          },
        });
      }
    }

    if (hashtags !== undefined) {
      // Zwei Schritte: erst lösen, dann setzen — die Reihenfolge innerhalb
      // eines einzelnen `update` ist bei Prisma nicht zugesichert.
      await tx.ticket.update({
        where: { id: changeRequest.ticketId },
        data: { hashtags: { set: [] } },
      });
      await tx.ticket.update({
        where: { id: changeRequest.ticketId },
        data: {
          hashtags: {
            connectOrCreate: hashtags.map((tag) => ({
              where: { tag },
              create: { tag },
            })),
          },
        },
      });
    }

    await tx.ticket.update({
      where: { id: changeRequest.ticketId },
      data: {
        // 10.4: jede Inhaltsänderung invalidiert die Basis offener Anträge.
        contentRevision: { increment: 1 },
        // Proof of Stake: der Antragsteller wird Co-Autor (idempotent).
        coAuthors: { connect: { id: changeRequest.authorId } },
      },
    });

    await refreshTicketCounters(tx, changeRequest.ticketId);
    return null;
  });
}

/**
 * «Übernehmen» (P10.3, E15): unverändert 1:1. Kein AI-Aufruf — die Fassungen
 * kommen aus der Datenbank und haben den Linter beim Einreichen passiert.
 */
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

  const parsed = mergeChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const { changeRequestId, revisedAt } = parsed.data;

  const guard = await loadDecidableChangeRequest(
    changeRequestId,
    userId,
    ["OPEN"],
    revisedAt,
  );
  if (!guard.ok) {
    return guard;
  }

  const stored = await loadStoredVersions(changeRequestId);
  if (!stored) {
    return { ok: false, error: "invalid_input" };
  }

  const failure = await applyMerge({
    changeRequestId,
    userId,
    seenRevisedAt: revisedAt,
    versions: stored.versions,
    hashtags: stored.hashtags,
    edited: false,
  });
  return failure ? { ok: false, error: failure } : { ok: true };
}

/**
 * Prüft eine Anpassung des Ticket-Autors gegen den gespeicherten Antrag
 * (E15): Sie darf genau die Felder tragen, die der Antrag betrifft — sonst
 * könnte der Autor über einen fremden Antrag beliebige Felder ändern und die
 * Änderung dem Antragsteller zuschreiben.
 */
function checkAdjustmentShape(
  adjusted: ChangeRequestProposal,
  adjustedHashtags: string[] | undefined,
  stored: ChangeRequestProposal,
  storedTags: string[] | undefined,
): boolean {
  return (
    fieldSet(adjusted) === fieldSet(stored) &&
    (adjustedHashtags === undefined) === (storedTags === undefined)
  );
}

/** «Anpassen & übernehmen», Schritt 1 (E15): prüfen und neu übersetzen. */
export async function prepareAdjustedMerge(
  input: unknown,
): Promise<PrepareAdjustedMergeResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "change-request-merge-prepare",
    identifier: userId,
    limit: 10,
    windowSeconds: 900,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const budget = await checkAiBudget();
  if (!budget.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = prepareAdjustedMergeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const data = parsed.data;

  const guard = await loadDecidableChangeRequest(
    data.changeRequestId,
    userId,
    ["OPEN"],
    data.revisedAt,
  );
  if (!guard.ok) {
    return guard;
  }

  const stored = await loadStoredVersions(data.changeRequestId);
  if (!stored) {
    return { ok: false, error: "invalid_input" };
  }
  const adjusted = toProposal(data);
  const storedVersion = stored.versions[data.locale];
  if (
    !checkAdjustmentShape(
      adjusted,
      data.hashtags,
      storedVersion,
      stored.hashtags,
    )
  ) {
    return { ok: false, error: "invalid_input" };
  }
  // Nichts angepasst: Dafür gibt es «Übernehmen» — ohne AI-Kosten und ohne
  // dass neue Übersetzungen die Fassungen des Antragstellers ersetzen.
  if (
    sameProposal(adjusted, storedVersion) &&
    (data.hashtags === undefined ||
      sameHashtags(data.hashtags, stored.hashtags ?? []))
  ) {
    return { ok: false, error: "no_changes" };
  }

  try {
    const blocked = await lintFields<ChangeRequestField>(
      proposalLintFields(adjusted, data.hashtags),
      data.locale,
      data.locale,
    );
    if (Object.keys(blocked).length > 0) {
      return { ok: false, error: "linter", fields: blocked };
    }
    const translations = await translateProposal(adjusted, data.locale);
    return { ok: true, translations };
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }
}

/** «Anpassen & übernehmen», Schritt 2 (E15): alle Fassungen prüfen, mergen. */
export async function mergeAdjustedChangeRequest(
  input: unknown,
): Promise<MergeAdjustedChangeRequestResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  // Gleiches Budget wie die 1:1-Übernahme: beides ist ein Merge.
  const limit = await checkRateLimit({
    scope: "change-request-merge",
    identifier: userId,
    limit: 20,
    windowSeconds: 3600,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const budget = await checkAiBudget();
  if (!budget.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = mergeAdjustedChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const data = parsed.data;

  const guard = await loadDecidableChangeRequest(
    data.changeRequestId,
    userId,
    ["OPEN"],
    data.revisedAt,
  );
  if (!guard.ok) {
    return guard;
  }

  const stored = await loadStoredVersions(data.changeRequestId);
  if (!stored) {
    return { ok: false, error: "invalid_input" };
  }
  const adjusted = toProposal(data);
  if (
    !checkAdjustmentShape(
      adjusted,
      data.hashtags,
      stored.versions[data.locale],
      stored.hashtags,
    )
  ) {
    return { ok: false, error: "invalid_input" };
  }

  const versions = { ...data.translations, [data.locale]: adjusted } as Record<
    AppLocale,
    ChangeRequestProposal
  >;

  try {
    // Jede Fassung ist Text des Ticket-Autors und läuft durch den Linter —
    // Begründungen in seiner Sprache.
    const blockedVersions = await lintVersions(
      versionList(data.locale, adjusted, data.hashtags, data.translations),
      data.locale,
    );
    if (Object.keys(blockedVersions).length > 0) {
      return { ok: false, error: "linter", versions: blockedVersions };
    }
  } catch (e) {
    if (e instanceof MistralUnavailableError) {
      return { ok: false, error: "ai_unavailable" };
    }
    throw e;
  }

  // Die Attribution entscheidet der SERVER: angepasst ist, was in irgendeiner
  // Sprache oder bei den Hashtags vom gespeicherten Vorschlag abweicht.
  const edited =
    routing.locales.some(
      (locale) => !sameProposal(versions[locale], stored.versions[locale]),
    ) ||
    (data.hashtags !== undefined &&
      !sameHashtags(data.hashtags, stored.hashtags ?? []));

  const failure = await applyMerge({
    changeRequestId: data.changeRequestId,
    userId,
    seenRevisedAt: data.revisedAt,
    versions,
    hashtags: data.hashtags,
    edited,
  });
  return failure ? { ok: false, error: failure } : { ok: true };
}

/** Zur Überarbeitung zurückgeben (E15) — Grund aus dem festen Katalog. */
export async function returnChangeRequest(
  input: unknown,
): Promise<SimpleChangeRequestResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "change-request-return",
    identifier: userId,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = returnChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }

  const guard = await loadDecidableChangeRequest(
    parsed.data.changeRequestId,
    userId,
    ["OPEN"],
    parsed.data.revisedAt,
  );
  if (!guard.ok) {
    return guard;
  }

  // Kein Zähler-Refresh: Ein Antrag in Überarbeitung zählt weiter wie ein
  // offener (er ist weiterhin konstruktive Arbeit am Ticket). Der Grund
  // bezieht sich auf die gesehene Fassung — deshalb derselbe Revisions-Claim
  // wie beim Übernehmen.
  const updated = await prisma.changeRequest.updateMany({
    where: {
      id: parsed.data.changeRequestId,
      status: "OPEN",
      contentStatus: "PUBLISHED",
      revisedAt: revisionValue(parsed.data.revisedAt),
    },
    data: {
      status: "CHANGES_REQUESTED",
      returnReason: parsed.data.reason,
      returnedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    return {
      ok: false,
      error: await claimFailure(prisma, parsed.data.changeRequestId),
    };
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

  // Auch ein zurückgegebener Antrag lässt sich ablehnen (E15) — sonst bliebe
  // er hängen, wenn der Antragsteller nie überarbeitet.
  const guard = await loadDecidableChangeRequest(
    parsed.data.changeRequestId,
    userId,
    ACTIVE_CHANGE_REQUEST_STATUSES,
  );
  if (!guard.ok) {
    return guard;
  }

  const declined = await prisma.$transaction(async (tx) => {
    await lockTicketRow(tx, guard.ticketId);
    const updated = await tx.changeRequest.updateMany({
      where: {
        id: parsed.data.changeRequestId,
        status: { in: [...ACTIVE_CHANGE_REQUEST_STATUSES] },
        contentStatus: "PUBLISHED",
      },
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

// ---------------------------------------------------------------------------
// Antragsteller — zurückziehen (E15). Überarbeiten läuft über
// prepareChangeRequest/submitChangeRequest mit `changeRequestId`.
// ---------------------------------------------------------------------------

export async function withdrawChangeRequest(
  input: unknown,
): Promise<SimpleChangeRequestResult> {
  const userId = await authenticatedUserId();
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  const limit = await checkRateLimit({
    scope: "change-request-withdraw",
    identifier: userId,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!limit.ok) {
    return { ok: false, error: "rate_limited" };
  }

  const parsed = withdrawChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input" };
  }
  const { changeRequestId } = parsed.data;

  const changeRequest = await prisma.changeRequest.findUnique({
    where: { id: changeRequestId },
    select: {
      authorId: true,
      status: true,
      ticketId: true,
      contentStatus: true,
    },
  });
  if (!changeRequest || changeRequest.contentStatus === "DEPUBLISHED") {
    return { ok: false, error: "invalid_input" };
  }
  if (changeRequest.authorId !== userId) {
    // Weder der Ticket-Autor noch ein Admin zieht fremde Anträge zurück.
    return { ok: false, error: "not_requester" };
  }
  if (!isActive(changeRequest.status)) {
    return { ok: false, error: "not_open" };
  }

  const withdrawn = await prisma.$transaction(async (tx) => {
    await lockTicketRow(tx, changeRequest.ticketId);
    const updated = await tx.changeRequest.updateMany({
      where: {
        id: changeRequestId,
        authorId: userId,
        status: { in: [...ACTIVE_CHANGE_REQUEST_STATUSES] },
        contentStatus: "PUBLISHED",
      },
      data: { status: "WITHDRAWN", decidedAt: new Date() },
    });
    if (updated.count === 0) {
      return false;
    }
    // Zurückgezogene Anträge zählen nicht in E — wie abgelehnte.
    await refreshTicketCounters(tx, changeRequest.ticketId);
    return true;
  });

  return withdrawn ? { ok: true } : { ok: false, error: "not_open" };
}
