-- Prisma cannot see the GIN/HNSW indexes on Unsupported columns and re-emits DROP INDEX for them; those lines are
-- stripped here on purpose. Only the columns and their foreign keys below are new.


-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "dateSetById" TEXT,
ADD COLUMN     "placeSetById" TEXT;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_placeSetById_fkey" FOREIGN KEY ("placeSetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_dateSetById_fkey" FOREIGN KEY ("dateSetById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
