-- CreateEnum
CREATE TYPE "PersonKind" AS ENUM ('HUMAN', 'PET');

-- CreateEnum
CREATE TYPE "Species" AS ENUM ('DOG', 'CAT', 'CHICKEN', 'HORSE', 'OTHER');

-- CreateEnum
CREATE TYPE "FaceStatus" AS ENUM ('DETECTED', 'PROPOSED', 'CONFIRMED', 'REJECTED');

-- DropIndex
DROP INDEX "Photo_embedding_idx";

-- DropIndex
DROP INDEX "Photo_textEmbedding_idx";

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "facesDetectedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "kind" "PersonKind" NOT NULL DEFAULT 'HUMAN',
    "name" TEXT NOT NULL,
    "relationship" TEXT,
    "birthday" DATE,
    "species" "Species",
    "livedFrom" DATE,
    "livedTo" DATE,
    "isFlock" BOOLEAN NOT NULL DEFAULT false,
    "faceIndexing" BOOLEAN NOT NULL DEFAULT false,
    "faceIndexingSetById" TEXT,
    "faceIndexingSetAt" TIMESTAMP(3),
    "adultAttestedById" TEXT,
    "adultAttestedAt" TIMESTAMP(3),
    "pendingDecision" BOOLEAN NOT NULL DEFAULT false,
    "keepNameOnPhotos" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaceCluster" (
    "id" TEXT NOT NULL,
    "personId" TEXT,
    "label" TEXT,
    "ageBandMin" INTEGER,
    "ageBandMax" INTEGER,
    "centroid" vector(512),
    "faceCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaceCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Face" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "clusterId" TEXT,
    "personId" TEXT,
    "proposedPersonId" TEXT,
    "box" JSONB NOT NULL,
    "embedding" vector(512),
    "confidence" DOUBLE PRECISION NOT NULL,
    "ageAtCaptureYears" DOUBLE PRECISION,
    "status" "FaceStatus" NOT NULL DEFAULT 'DETECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Face_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Person_name_idx" ON "Person"("name");

-- CreateIndex
CREATE INDEX "FaceCluster_personId_idx" ON "FaceCluster"("personId");

-- CreateIndex
CREATE INDEX "Face_photoId_idx" ON "Face"("photoId");

-- CreateIndex
CREATE INDEX "Face_clusterId_idx" ON "Face"("clusterId");

-- CreateIndex
CREATE INDEX "Face_personId_idx" ON "Face"("personId");

-- CreateIndex
CREATE INDEX "Face_status_idx" ON "Face"("status");

-- AddForeignKey
ALTER TABLE "FaceCluster" ADD CONSTRAINT "FaceCluster_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Face" ADD CONSTRAINT "Face_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Face" ADD CONSTRAINT "Face_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "FaceCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Face" ADD CONSTRAINT "Face_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Face" ADD CONSTRAINT "Face_proposedPersonId_fkey" FOREIGN KEY ("proposedPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Face_embedding_idx" ON "Face" USING hnsw ("embedding" vector_cosine_ops);

-- Confirmed people's names join the members-only search column (never the anonymous one).
CREATE OR REPLACE FUNCTION photo_search_members_extra(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('simple', coalesce((SELECT u.name FROM "User" u WHERE u.id = p."uploaderId"), '')), 'C')
      || setweight(to_tsvector('simple', coalesce((SELECT string_agg(DISTINCT pe.name, ' ') FROM "Face" f JOIN "Person" pe ON pe.id = f."personId" WHERE f."photoId" = p.id AND f.status = 'CONFIRMED'), '')), 'A');
$$;

CREATE OR REPLACE FUNCTION photo_search_refresh_by_face() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE id = COALESCE(NEW."photoId", OLD."photoId");
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS face_search_trigger ON "Face";
CREATE TRIGGER face_search_trigger AFTER INSERT OR UPDATE OF "personId", status OR DELETE ON "Face"
  FOR EACH ROW EXECUTE FUNCTION photo_search_refresh_by_face();

CREATE OR REPLACE FUNCTION photo_search_refresh_person_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE id IN (SELECT "photoId" FROM "Face" WHERE "personId" = NEW.id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS person_name_search_trigger ON "Person";
CREATE TRIGGER person_name_search_trigger AFTER UPDATE ON "Person"
  FOR EACH ROW EXECUTE FUNCTION photo_search_refresh_person_name();
