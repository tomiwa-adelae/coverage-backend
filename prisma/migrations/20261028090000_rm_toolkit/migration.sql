-- CreateEnum
CREATE TYPE "Product" AS ENUM ('CURRENT', 'SAVINGS', 'FIXED_DEPOSIT', 'DOMICILIARY', 'POS', 'LOAN', 'PAYROLL', 'TRADE', 'DIGITAL');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('REFERRAL', 'EXISTING_CUSTOMER', 'PERSONAL_NETWORK', 'WALK_IN', 'EVENT', 'COLD_OUTREACH', 'SOCIAL_MEDIA', 'OTHER');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('INTERESTED', 'CALL_BACK', 'NOT_NOW', 'NO_ANSWER', 'WRONG_NUMBER', 'NOT_INTERESTED');

-- CreateEnum
CREATE TYPE "ConsentMethod" AS ENUM ('VERBAL', 'WRITTEN', 'WHATSAPP', 'EMAIL', 'FORM');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('MANAGER', 'MEMBER');

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "outcome" "CallOutcome";

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "address" TEXT,
ADD COLUMN     "area" TEXT,
ADD COLUMN     "birthday" TEXT,
ADD COLUMN     "cadenceId" TEXT,
ADD COLUMN     "cadenceStart" DATE,
ADD COLUMN     "cadenceStep" INTEGER,
ADD COLUMN     "consentAt" TIMESTAMP(3),
ADD COLUMN     "consentMethod" "ConsentMethod",
ADD COLUMN     "consentNote" TEXT,
ADD COLUMN     "holdsProducts" "Product"[],
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "outcomeReason" TEXT,
ADD COLUMN     "referredById" TEXT,
ADD COLUMN     "source" "Source",
ADD COLUMN     "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "wantsProducts" "Product"[];

-- AlterTable
ALTER TABLE "User" DROP COLUMN "refreshTokenHash",
ADD COLUMN     "backupCodes" TEXT[],
ADD COLUMN     "cadencesSeeded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "calendarToken" TEXT,
ADD COLUMN     "digestEmail" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "digestHour" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "digestPush" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastDigestOn" TEXT,
ADD COLUMN     "lastReportOn" TEXT,
ADD COLUMN     "managerEmail" TEXT,
ADD COLUMN     "targetEndDate" DATE,
ADD COLUMN     "teamId" TEXT,
ADD COLUMN     "teamRole" "TeamRole",
ADD COLUMN     "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorSecret" TEXT,
ADD COLUMN     "weeklyReport" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Balance" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cadence" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cadence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Team_inviteCode_key" ON "Team"("inviteCode");

-- CreateIndex
CREATE INDEX "Balance_userId_month_idx" ON "Balance"("userId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Balance_prospectId_month_key" ON "Balance"("prospectId", "month");

-- CreateIndex
CREATE INDEX "Cadence_ownerId_idx" ON "Cadence"("ownerId");

-- CreateIndex
CREATE INDEX "Prospect_referredById_idx" ON "Prospect"("referredById");

-- CreateIndex
CREATE UNIQUE INDEX "User_calendarToken_key" ON "User"("calendarToken");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_cadenceId_fkey" FOREIGN KEY ("cadenceId") REFERENCES "Cadence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Balance" ADD CONSTRAINT "Balance_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Balance" ADD CONSTRAINT "Balance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cadence" ADD CONSTRAINT "Cadence_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: when each prospect entered its current stage.
UPDATE "Prospect" p SET "stageChangedAt" = COALESCE(
  (SELECT MAX(a."occurredAt") FROM "Activity" a
    WHERE a."prospectId" = p."id" AND a."type" = 'STAGE_CHANGE' AND a."toStage" = p."stage"),
  p."createdAt");

-- Backfill: existing funded amounts become this month's balance.
INSERT INTO "Balance" ("id", "prospectId", "userId", "month", "amount", "updatedAt")
SELECT gen_random_uuid()::text, p."id", p."ownerId", date_trunc('month', now())::date, p."funded", now()
FROM "Prospect" p WHERE p."funded" IS NOT NULL AND p."funded" > 0;
