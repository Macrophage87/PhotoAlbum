-- Prisma re-emits drops for the indexes it cannot see on Unsupported columns; they are deliberately left out here.
-- AlterTable
ALTER TABLE "AnnotationBatch" ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "skippedReasons" JSONB;

-- CreateIndex
CREATE INDEX "AnnotationBatch_parentId_idx" ON "AnnotationBatch"("parentId");
