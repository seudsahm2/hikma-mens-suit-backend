-- AlterTable
ALTER TABLE "Settings"
ADD COLUMN "exchangeFeeType" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN "exchangeFeeValue" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "damageFeeType" TEXT NOT NULL DEFAULT 'fixed',
ADD COLUMN "damageFeeValue" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "exchangeId" TEXT;

-- AlterTable
ALTER TABLE "ExchangeRequest"
ADD COLUMN "replacementOrderId" TEXT,
ADD COLUMN "deliveryFee" INTEGER,
ADD COLUMN "returnStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "damagePhotoKey" TEXT,
ADD COLUMN "damageFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "damagePaid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "damageNote" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRequest_replacementOrderId_key" ON "ExchangeRequest"("replacementOrderId");

-- AlterTable
ALTER TABLE "Driver"
ADD COLUMN "awaitingPhotoOrderId" TEXT,
ADD COLUMN "canPriceDamage" BOOLEAN NOT NULL DEFAULT false;
