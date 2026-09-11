-- DropIndex
DROP INDEX "Face_embedding_idx";

-- CreateTable
CREATE TABLE "MediaSimilarity" (
    "photoAId" TEXT NOT NULL,
    "photoBId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "MediaSimilarity_pkey" PRIMARY KEY ("photoAId","photoBId")
);

-- CreateIndex
CREATE INDEX "MediaSimilarity_photoBId_idx" ON "MediaSimilarity"("photoBId");

-- CreateIndex
CREATE INDEX "MediaSimilarity_score_idx" ON "MediaSimilarity"("score");

-- AddForeignKey
ALTER TABLE "MediaSimilarity" ADD CONSTRAINT "MediaSimilarity_photoAId_fkey" FOREIGN KEY ("photoAId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaSimilarity" ADD CONSTRAINT "MediaSimilarity_photoBId_fkey" FOREIGN KEY ("photoBId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
