-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('DE', 'FR', 'IT');

-- CreateEnum
CREATE TYPE "PoliticalLevel" AS ENUM ('FEDERAL', 'CANTONAL', 'MUNICIPAL');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('PUBLISHED', 'DEPUBLISHED');

-- CreateEnum
CREATE TYPE "StatementCategory" AS ENUM ('PRO', 'CONTRA', 'ERWEITERUNG', 'FRAGE');

-- CreateEnum
CREATE TYPE "VoteValue" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('M', 'F', 'D');

-- CreateEnum
CREATE TYPE "EducationLevel" AS ENUM ('OBLIGATORISCHE_SCHULE', 'BERUFSLEHRE', 'GYMNASIALE_MATURA', 'HOEHERE_BERUFSBILDUNG', 'BACHELOR', 'MASTER_ODER_HOEHER');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('OPEN', 'MERGED', 'DECLINED');

-- CreateEnum
CREATE TYPE "ModerationCaseType" AS ENUM ('APPEAL', 'REPORT');

-- CreateEnum
CREATE TYPE "ModerationCaseStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "handle" TEXT,
    "preferredLocale" "Locale" NOT NULL DEFAULT 'DE',
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "birthYear" INTEGER,
    "gender" "Gender",
    "education" "EducationLevel",
    "postalCode" TEXT,
    "occupation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Canton" (
    "id" INTEGER NOT NULL,
    "abbr" TEXT NOT NULL,
    "nameDe" TEXT NOT NULL,
    "nameFr" TEXT NOT NULL,
    "nameIt" TEXT NOT NULL,

    CONSTRAINT "Canton_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Municipality" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "cantonId" INTEGER NOT NULL,

    CONSTRAINT "Municipality_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "level" "PoliticalLevel" NOT NULL,
    "cantonId" INTEGER,
    "municipalityId" INTEGER,
    "status" "ContentStatus" NOT NULL DEFAULT 'PUBLISHED',
    "originalLocale" "Locale" NOT NULL,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "downvotes" INTEGER NOT NULL DEFAULT 0,
    "statementCount" INTEGER NOT NULL DEFAULT 0,
    "changeRequestCount" INTEGER NOT NULL DEFAULT 0,
    "score_consensus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "score_controversy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "score_trending" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "solutionRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketTranslation" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "isOriginal" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "problem" JSONB NOT NULL,
    "solution" JSONB NOT NULL,
    "funding" JSONB,

    CONSTRAINT "TicketTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hashtag" (
    "id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "Hashtag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Statement" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "category" "StatementCategory" NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'PUBLISHED',
    "originalLocale" "Locale" NOT NULL,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "downvotes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementTranslation" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "isOriginal" BOOLEAN NOT NULL DEFAULT false,
    "content" JSONB NOT NULL,

    CONSTRAINT "StatementTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketVote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "value" "VoteValue" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementVote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "value" "VoteValue" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatementVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "originalLocale" "Locale" NOT NULL,
    "baseSolutionRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequestTranslation" (
    "id" TEXT NOT NULL,
    "changeRequestId" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "isOriginal" BOOLEAN NOT NULL DEFAULT false,
    "solution" JSONB NOT NULL,

    CONSTRAINT "ChangeRequestTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "type" "ModerationCaseType" NOT NULL,
    "status" "ModerationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "reporterId" TEXT NOT NULL,
    "ticketId" TEXT,
    "statementId" TEXT,
    "changeRequestId" TEXT,
    "reason" TEXT NOT NULL,
    "blockedContent" JSONB,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_TicketCoAuthors" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TicketCoAuthors_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_HashtagToTicket" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_HashtagToTicket_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Canton_abbr_key" ON "Canton"("abbr");

-- CreateIndex
CREATE INDEX "Municipality_name_idx" ON "Municipality"("name");

-- CreateIndex
CREATE INDEX "Municipality_cantonId_idx" ON "Municipality"("cantonId");

-- CreateIndex
CREATE INDEX "Ticket_status_score_consensus_idx" ON "Ticket"("status", "score_consensus" DESC);

-- CreateIndex
CREATE INDEX "Ticket_status_score_controversy_idx" ON "Ticket"("status", "score_controversy" DESC);

-- CreateIndex
CREATE INDEX "Ticket_status_score_trending_idx" ON "Ticket"("status", "score_trending" DESC);

-- CreateIndex
CREATE INDEX "Ticket_authorId_idx" ON "Ticket"("authorId");

-- CreateIndex
CREATE INDEX "TicketTranslation_title_idx" ON "TicketTranslation" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "TicketTranslation_ticketId_locale_key" ON "TicketTranslation"("ticketId", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "Hashtag_tag_key" ON "Hashtag"("tag");

-- CreateIndex
CREATE INDEX "Hashtag_tag_idx" ON "Hashtag" USING GIN ("tag" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Statement_ticketId_category_idx" ON "Statement"("ticketId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "StatementTranslation_statementId_locale_key" ON "StatementTranslation"("statementId", "locale");

-- CreateIndex
CREATE INDEX "TicketVote_userId_createdAt_idx" ON "TicketVote"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TicketVote_userId_ticketId_key" ON "TicketVote"("userId", "ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementVote_userId_statementId_key" ON "StatementVote"("userId", "statementId");

-- CreateIndex
CREATE INDEX "ChangeRequest_ticketId_status_idx" ON "ChangeRequest"("ticketId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeRequestTranslation_changeRequestId_locale_key" ON "ChangeRequestTranslation"("changeRequestId", "locale");

-- CreateIndex
CREATE INDEX "ModerationCase_status_type_createdAt_idx" ON "ModerationCase"("status", "type", "createdAt");

-- CreateIndex
CREATE INDEX "_TicketCoAuthors_B_index" ON "_TicketCoAuthors"("B");

-- CreateIndex
CREATE INDEX "_HashtagToTicket_B_index" ON "_HashtagToTicket"("B");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Municipality" ADD CONSTRAINT "Municipality_cantonId_fkey" FOREIGN KEY ("cantonId") REFERENCES "Canton"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_cantonId_fkey" FOREIGN KEY ("cantonId") REFERENCES "Canton"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_municipalityId_fkey" FOREIGN KEY ("municipalityId") REFERENCES "Municipality"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTranslation" ADD CONSTRAINT "TicketTranslation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementTranslation" ADD CONSTRAINT "StatementTranslation_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketVote" ADD CONSTRAINT "TicketVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketVote" ADD CONSTRAINT "TicketVote_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementVote" ADD CONSTRAINT "StatementVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementVote" ADD CONSTRAINT "StatementVote_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequestTranslation" ADD CONSTRAINT "ChangeRequestTranslation_changeRequestId_fkey" FOREIGN KEY ("changeRequestId") REFERENCES "ChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_changeRequestId_fkey" FOREIGN KEY ("changeRequestId") REFERENCES "ChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketCoAuthors" ADD CONSTRAINT "_TicketCoAuthors_A_fkey" FOREIGN KEY ("A") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketCoAuthors" ADD CONSTRAINT "_TicketCoAuthors_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_HashtagToTicket" ADD CONSTRAINT "_HashtagToTicket_A_fkey" FOREIGN KEY ("A") REFERENCES "Hashtag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_HashtagToTicket" ADD CONSTRAINT "_HashtagToTicket_B_fkey" FOREIGN KEY ("B") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
