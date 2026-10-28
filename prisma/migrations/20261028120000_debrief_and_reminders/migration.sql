-- CreateEnum
CREATE TYPE "DebriefStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'APPLIED');

-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "nextTime" TEXT,
ADD COLUMN     "remindedFor" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "reminderLead" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "Debrief" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "DebriefStatus" NOT NULL DEFAULT 'UPLOADING',
    "step" TEXT,
    "transcript" TEXT,
    "result" JSONB,
    "applied" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Debrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Debrief_userId_createdAt_idx" ON "Debrief"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Debrief" ADD CONSTRAINT "Debrief_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

