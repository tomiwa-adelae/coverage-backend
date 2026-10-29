-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "referralAskedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastBalanceNudge" TEXT;

-- CreateIndex
CREATE INDEX "Task_ownerId_source_idx" ON "Task"("ownerId", "source");

