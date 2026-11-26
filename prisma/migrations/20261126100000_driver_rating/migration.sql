-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "driverRatedAt" TIMESTAMP(3),
ADD COLUMN     "driverRating" INTEGER,
ADD COLUMN     "driverRatingNote" TEXT;

