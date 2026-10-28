-- AlterTable
ALTER TABLE "Prospect" ADD COLUMN     "checkedInFor" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "debriefHour" INTEGER NOT NULL DEFAULT 17,
ADD COLUMN     "lastDebriefNudgeOn" TEXT;

