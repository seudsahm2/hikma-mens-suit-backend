-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "IdentityCheck" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "gender" TEXT,
    "dateOfBirth" TEXT,
    "fan" TEXT NOT NULL,
    "cardVersion" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "face" BYTEA,
    "checkedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdentityCheck_subjectType_subjectId_idx" ON "IdentityCheck"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "IdentityCheck_fan_idx" ON "IdentityCheck"("fan");

