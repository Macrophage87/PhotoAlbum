-- Prisma re-emits drops for the indexes it cannot see on Unsupported columns; they are deliberately left out here.
-- AlterTable
ALTER TABLE "AnnotationBatch" ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "runEndedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "annotationCacheWriteTokens" INTEGER;
