-- AlterTable
ALTER TABLE "User" ADD COLUMN     "staffLinkCode" TEXT,
ADD COLUMN     "staffTelegramId" BIGINT;

-- CreateIndex
CREATE UNIQUE INDEX "User_staffTelegramId_key" ON "User"("staffTelegramId");

-- CreateIndex
CREATE UNIQUE INDEX "User_staffLinkCode_key" ON "User"("staffLinkCode");

