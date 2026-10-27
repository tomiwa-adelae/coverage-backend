-- CreateEnum
CREATE TYPE "Role" AS ENUM ('RM', 'ADMIN');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('IDENTIFIED', 'CONTACTED', 'INTERESTED', 'FORMS_SENT', 'FORMS_RECEIVED', 'ACCOUNT_OPENED', 'FUNDED', 'DECLINED');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('CALL', 'WHATSAPP', 'VISIT', 'MEETING', 'EMAIL', 'SMS', 'STAGE_CHANGE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "refreshTokenHash" TEXT,
    "role" "Role" NOT NULL DEFAULT 'RM',
    "targetAmount" BIGINT NOT NULL DEFAULT 180000000,
    "targetStartDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "group" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "tier" "Tier",
    "stage" "Stage" NOT NULL DEFAULT 'IDENTIFIED',
    "potential" BIGINT,
    "funded" BIGINT,
    "nextAction" TEXT,
    "nextDate" DATE,
    "notes" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "note" TEXT,
    "fromStage" "Stage",
    "toStage" "Stage",
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Prospect_ownerId_nextDate_idx" ON "Prospect"("ownerId", "nextDate");

-- CreateIndex
CREATE INDEX "Prospect_ownerId_stage_idx" ON "Prospect"("ownerId", "stage");

-- CreateIndex
CREATE INDEX "Activity_userId_occurredAt_idx" ON "Activity"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_prospectId_occurredAt_idx" ON "Activity"("prospectId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
