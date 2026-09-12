-- Prisma cannot see indexes declared on Unsupported("vector") columns, so every new migration it writes re-emits a
-- DROP INDEX for the six GIN/HNSW indexes. Those lines are stripped here; the indexes are created by the migration
-- that added them and must stay.

-- CreateEnum
CREATE TYPE "TrashReason" AS ENUM ('BLURRY', 'DUPLICATE', 'ACCIDENT', 'PRIVATE', 'SOMEONE_ASKED', 'NOT_WORTH_KEEPING', 'OTHER');

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "trashNote" TEXT,
ADD COLUMN     "trashReason" "TrashReason",
ADD COLUMN     "trashedAt" TIMESTAMP(3),
ADD COLUMN     "trashedById" TEXT;

-- CreateIndex
CREATE INDEX "Photo_trashedAt_idx" ON "Photo"("trashedAt");

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_trashedById_fkey" FOREIGN KEY ("trashedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
