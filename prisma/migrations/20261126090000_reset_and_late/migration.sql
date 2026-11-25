-- AlterTable
ALTER TABLE "DeliveryOffer" ADD COLUMN     "handedAt" TIMESTAMP(3),
ADD COLUMN     "lateAlertAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "resetCodeHash" TEXT,
ADD COLUMN     "resetExpires" TIMESTAMP(3),
ADD COLUMN     "resetTries" INTEGER NOT NULL DEFAULT 0;

