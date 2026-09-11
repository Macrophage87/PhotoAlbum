-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'VIDEO', 'EXTERNAL_VIDEO');

-- CreateEnum
CREATE TYPE "MediaSourceKind" AS ENUM ('UPLOAD', 'YOUTUBE');

-- CreateEnum
CREATE TYPE "ExternalProvider" AS ENUM ('YOUTUBE');

-- CreateEnum
CREATE TYPE "ExternalStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "durationS" DOUBLE PRECISION,
ADD COLUMN     "externalCheckedAt" TIMESTAMP(3),
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "externalStatus" "ExternalStatus",
ADD COLUMN     "externalUrl" TEXT,
ADD COLUMN     "kind" "MediaKind" NOT NULL DEFAULT 'PHOTO',
ADD COLUMN     "provider" "ExternalProvider",
ADD COLUMN     "sourceKind" "MediaSourceKind" NOT NULL DEFAULT 'UPLOAD',
ADD COLUMN     "title" TEXT;

-- CreateIndex
CREATE INDEX "Photo_kind_idx" ON "Photo"("kind");

-- CreateIndex
CREATE INDEX "Photo_provider_externalId_idx" ON "Photo"("provider", "externalId");
