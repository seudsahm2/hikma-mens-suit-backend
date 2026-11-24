-- AlterEnum
ALTER TYPE "OrderSource" ADD VALUE 'COUNTER';

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "bagReminders" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dailyReport" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastReportDate" TEXT,
ADD COLUMN     "reportHour" INTEGER NOT NULL DEFAULT 21;

-- CreateTable
CREATE TABLE "CartSnapshot" (
    "userId" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "remindedAt" TIMESTAMP(3),

    CONSTRAINT "CartSnapshot_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "CartSnapshot_updatedAt_idx" ON "CartSnapshot"("updatedAt");

-- AddForeignKey
ALTER TABLE "CartSnapshot" ADD CONSTRAINT "CartSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
