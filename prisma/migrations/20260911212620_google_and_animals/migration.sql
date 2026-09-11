-- Prisma re-emits drops for the indexes it cannot see on Unsupported columns; they are deliberately left out here.
-- CreateEnum
CREATE TYPE "TakeoutImportStatus" AS ENUM ('RUNNING', 'ENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnimalStatus" AS ENUM ('DETECTED', 'PROPOSED', 'CONFIRMED', 'REJECTED');

-- AlterEnum
ALTER TYPE "GpsSource" ADD VALUE 'SIDECAR';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MediaSourceKind" ADD VALUE 'TAKEOUT';
ALTER TYPE "MediaSourceKind" ADD VALUE 'GOOGLE_PICKER';

-- AlterEnum
ALTER TYPE "TakenAtSource" ADD VALUE 'SIDECAR';

-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "descriptors" TEXT;

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "animalsDetectedAt" TIMESTAMP(3),
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "sourceId" TEXT;

-- CreateTable
CREATE TABLE "AnimalDetection" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "species" "Species" NOT NULL,
    "box" JSONB NOT NULL,
    "embedding" vector(512),
    "confidence" DOUBLE PRECISION NOT NULL,
    "personId" TEXT,
    "proposedPersonId" TEXT,
    "status" "AnimalStatus" NOT NULL DEFAULT 'DETECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnimalDetection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TakeoutImport" (
    "id" TEXT NOT NULL,
    "archiveName" TEXT NOT NULL,
    "status" "TakeoutImportStatus" NOT NULL DEFAULT 'RUNNING',
    "imported" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "collectionsCreated" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "TakeoutImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleAccount" (
    "userId" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "needsReconnect" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "GoogleAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "AnimalDetection_photoId_idx" ON "AnimalDetection"("photoId");

-- CreateIndex
CREATE INDEX "AnimalDetection_personId_idx" ON "AnimalDetection"("personId");

-- CreateIndex
CREATE INDEX "AnimalDetection_status_idx" ON "AnimalDetection"("status");

-- CreateIndex
CREATE INDEX "Photo_contentHash_idx" ON "Photo"("contentHash");

-- CreateIndex
CREATE INDEX "Photo_sourceKind_sourceId_idx" ON "Photo"("sourceKind", "sourceId");

-- AddForeignKey
ALTER TABLE "AnimalDetection" ADD CONSTRAINT "AnimalDetection_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnimalDetection" ADD CONSTRAINT "AnimalDetection_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnimalDetection" ADD CONSTRAINT "AnimalDetection_proposedPersonId_fkey" FOREIGN KEY ("proposedPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleAccount" ADD CONSTRAINT "GoogleAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AnimalDetection_embedding_idx" ON "AnimalDetection" USING hnsw ("embedding" vector_cosine_ops);

-- Confirmed animal detections carry a pet's name into the members' search column like confirmed faces do.
CREATE OR REPLACE FUNCTION photo_search_members_extra(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('simple', coalesce((SELECT u.name FROM "User" u WHERE u.id = p."uploaderId"), '')), 'C')
      || setweight(to_tsvector('simple', coalesce((SELECT string_agg(DISTINCT pe.name, ' ') FROM "Face" f JOIN "Person" pe ON pe.id = f."personId" WHERE f."photoId" = p.id AND f.status = 'CONFIRMED' AND pe."optedOutAt" IS NULL), '')), 'A')
      || setweight(to_tsvector('simple', coalesce((SELECT string_agg(DISTINCT pe.name, ' ') FROM "AnimalDetection" a JOIN "Person" pe ON pe.id = a."personId" WHERE a."photoId" = p.id AND a.status = 'CONFIRMED'), '')), 'A');
$$;

CREATE OR REPLACE FUNCTION photo_search_refresh_by_animal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE id = COALESCE(NEW."photoId", OLD."photoId");
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS animal_search_trigger ON "AnimalDetection";
CREATE TRIGGER animal_search_trigger AFTER INSERT OR UPDATE OF "personId", status OR DELETE ON "AnimalDetection"
  FOR EACH ROW EXECUTE FUNCTION photo_search_refresh_by_animal();
