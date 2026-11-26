-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "note" TEXT,
ADD COLUMN     "recipientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

