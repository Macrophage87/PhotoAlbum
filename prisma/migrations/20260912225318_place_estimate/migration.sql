-- Prisma cannot see indexes declared on Unsupported("vector") columns, so every new migration it writes re-emits a
-- DROP INDEX for the six GIN/HNSW indexes. Those lines are stripped here; the indexes are created by the migration
-- that added them and must stay.

-- AlterEnum
ALTER TYPE "GpsSource" ADD VALUE 'ESTIMATE';

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "placeEstimateConfidence" DOUBLE PRECISION,
ADD COLUMN     "placeEstimateName" TEXT,
ADD COLUMN     "placeEstimateNote" TEXT,
ADD COLUMN     "placeEstimateRadiusM" INTEGER,
ADD COLUMN     "placeEstimatedAt" TIMESTAMP(3);
