-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "awaitingOrderId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryCode" TEXT,
ADD COLUMN     "deliveryCodeTries" INTEGER NOT NULL DEFAULT 0;

