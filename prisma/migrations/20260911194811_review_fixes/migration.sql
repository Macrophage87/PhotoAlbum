-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "optedOutAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "annotationBatched" BOOLEAN,
ADD COLUMN     "annotationCacheReadTokens" INTEGER,
ADD COLUMN     "annotationInputTokens" INTEGER,
ADD COLUMN     "annotationOutputTokens" INTEGER;

-- Prisma cannot see the indexes on Unsupported columns and dropped them in later migrations; recreate them here (and a unit test now checks they exist).
CREATE INDEX IF NOT EXISTS "Photo_searchVector_idx" ON "Photo" USING GIN ("searchVector");
CREATE INDEX IF NOT EXISTS "Photo_searchVectorMembers_idx" ON "Photo" USING GIN ("searchVectorMembers");
CREATE INDEX IF NOT EXISTS "Photo_embedding_idx" ON "Photo" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "Photo_textEmbedding_idx" ON "Photo" USING hnsw ("textEmbedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "Face_embedding_idx" ON "Face" USING hnsw ("embedding" vector_cosine_ops);

-- People who asked to be forgotten leave the members' name index even when their name stays on confirmed photos.
CREATE OR REPLACE FUNCTION photo_search_members_extra(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('simple', coalesce((SELECT u.name FROM "User" u WHERE u.id = p."uploaderId"), '')), 'C')
      || setweight(to_tsvector('simple', coalesce((SELECT string_agg(DISTINCT pe.name, ' ') FROM "Face" f JOIN "Person" pe ON pe.id = f."personId" WHERE f."photoId" = p.id AND f.status = 'CONFIRMED' AND pe."optedOutAt" IS NULL), '')), 'A');
$$;
