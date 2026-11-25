-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cashCollected" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cashDriverId" TEXT,
ADD COLUMN     "cashSettledAt" TIMESTAMP(3);

