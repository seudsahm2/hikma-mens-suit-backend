-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cancelAt" TIMESTAMP(3),
ADD COLUMN     "cancelById" TEXT,
ADD COLUMN     "cancelNote" TEXT;

