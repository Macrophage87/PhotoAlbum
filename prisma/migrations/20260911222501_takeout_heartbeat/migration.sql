-- Prisma cannot see the GIN/HNSW indexes on Unsupported columns and re-emits DROP INDEX for them; those lines are
-- stripped here on purpose. Only the column below is new.

-- AlterTable
ALTER TABLE "TakeoutImport" ADD COLUMN     "heartbeatAt" TIMESTAMP(3);
