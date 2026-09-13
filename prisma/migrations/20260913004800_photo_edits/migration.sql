-- Prisma cannot see indexes declared on Unsupported("vector") columns, so every new migration it writes re-emits a
-- DROP INDEX for the six GIN/HNSW indexes. Those lines are stripped here; the indexes are created by the migration
-- that added them and must stay.

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "editedById" TEXT,
ADD COLUMN     "edits" JSONB;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
