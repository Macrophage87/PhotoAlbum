-- CreateEnum
CREATE TYPE "VisitorKind" AS ENUM ('MEMBER', 'SHARE', 'PUBLIC');

-- Prisma cannot see indexes on Unsupported() columns (the search vectors and the embedding vectors) and asks
-- to drop them in every migration it writes. Those DropIndex lines were removed by hand, exactly as the
-- review_fixes migration explains; a unit test checks the indexes are still there afterwards.

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "VisitorKind" NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "userId" TEXT,
    "section" TEXT NOT NULL,
    "tripId" TEXT,
    "collectionId" TEXT,
    "photoId" TEXT,
    "refHost" TEXT,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitSalt" (
    "day" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitSalt_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "Visit_at_idx" ON "Visit"("at");

-- CreateIndex
CREATE INDEX "Visit_kind_at_idx" ON "Visit"("kind", "at");

-- CreateIndex
CREATE INDEX "Visit_tripId_at_idx" ON "Visit"("tripId", "at");

-- CreateIndex
CREATE INDEX "Visit_collectionId_at_idx" ON "Visit"("collectionId", "at");

-- CreateIndex
CREATE INDEX "Visit_photoId_at_idx" ON "Visit"("photoId", "at");

-- CreateIndex
CREATE INDEX "Visit_userId_at_idx" ON "Visit"("userId", "at");

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
