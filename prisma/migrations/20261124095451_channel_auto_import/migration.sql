-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "channelAutoImport" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ChannelImport" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageIds" INTEGER[],
    "fileIds" TEXT[],
    "caption" TEXT NOT NULL DEFAULT '',
    "postedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "productId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelImport_status_updatedAt_idx" ON "ChannelImport"("status", "updatedAt");
