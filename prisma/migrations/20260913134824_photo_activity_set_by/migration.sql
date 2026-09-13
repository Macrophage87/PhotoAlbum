-- Prisma cannot see indexes declared on `Unsupported` columns (the GIN and HNSW indexes on the search vectors and
-- the embeddings), so it re-emits a DROP INDEX for each of them in every migration it generates. Those lines are
-- removed by hand here; the indexes must stay.

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "activitySetById" TEXT;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_activitySetById_fkey" FOREIGN KEY ("activitySetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
