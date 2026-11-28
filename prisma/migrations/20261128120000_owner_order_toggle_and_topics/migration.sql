-- AlterTable
ALTER TABLE "User" ADD COLUMN "staffTopicId" INTEGER;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "ownerCanOrder" BOOLEAN NOT NULL DEFAULT false;
