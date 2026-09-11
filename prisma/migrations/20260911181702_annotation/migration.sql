-- CreateEnum
CREATE TYPE "AnnotationSource" AS ENUM ('MACHINE', 'EDITED');

-- CreateEnum
CREATE TYPE "EstimatedDateSource" AS ENUM ('MODEL', 'MEMBER');

-- CreateEnum
CREATE TYPE "AnnotationBatchStatus" AS ENUM ('SUBMITTED', 'ENDED', 'CANCELLED', 'FAILED');

-- DropIndex
DROP INDEX "Photo_searchVectorMembers_idx";

-- DropIndex
DROP INDEX "Photo_searchVector_idx";

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "annotationOptOut" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "annotatedAt" TIMESTAMP(3),
ADD COLUMN     "annotation" JSONB,
ADD COLUMN     "annotationError" TEXT,
ADD COLUMN     "annotationModel" TEXT,
ADD COLUMN     "annotationOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "annotationSource" "AnnotationSource",
ADD COLUMN     "estimatedDate" TIMESTAMP(3),
ADD COLUMN     "estimatedDateConfidence" DOUBLE PRECISION,
ADD COLUMN     "estimatedDateNote" TEXT,
ADD COLUMN     "estimatedDateSource" "EstimatedDateSource";

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "annotationOptOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL DEFAULT 'app',
    "annotationOptInAt" TIMESTAMP(3),
    "annotationOptInById" TEXT,
    "faceDetectionOptInAt" TIMESTAMP(3),
    "faceDetectionOptInById" TEXT,
    "faceDataDeletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAnnotationRaw" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAnnotationRaw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnotationBatch" (
    "id" TEXT NOT NULL,
    "anthropicBatchId" TEXT NOT NULL,
    "status" "AnnotationBatchStatus" NOT NULL DEFAULT 'SUBMITTED',
    "scope" JSONB NOT NULL,
    "requested" INTEGER NOT NULL,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "errored" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AnnotationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaAnnotationRaw_photoId_idx" ON "MediaAnnotationRaw"("photoId");

-- CreateIndex
CREATE INDEX "MediaAnnotationRaw_createdAt_idx" ON "MediaAnnotationRaw"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnnotationBatch_anthropicBatchId_key" ON "AnnotationBatch"("anthropicBatchId");

-- AddForeignKey
ALTER TABLE "MediaAnnotationRaw" ADD CONSTRAINT "MediaAnnotationRaw_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The helper's description, tags and place join the base search column (visible to anyone who may see the item).
CREATE OR REPLACE FUNCTION photo_search_base(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('english', coalesce(p.caption, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.title, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'caption', '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.context, '')), 'B')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'description', '')), 'B')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'place', '')), 'B')
      || setweight(to_tsvector('english', coalesce((SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.annotation->'tags') = 'array' THEN p.annotation->'tags' ELSE '[]'::jsonb END) t), '')), 'B')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'searchSummary', '')), 'C')
      || setweight(to_tsvector('english', coalesce((SELECT t.title FROM "Trip" t WHERE t.id = p."tripId"), '')), 'C')
      || setweight(to_tsvector('english', coalesce((SELECT string_agg(c.title, ' ') FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" WHERE ci."photoId" = p.id), '')), 'C');
$$;
UPDATE "Photo" SET "updatedAt" = "updatedAt";
