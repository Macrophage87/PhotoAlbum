-- Prisma cannot see indexes on Unsupported() columns, so `prisma migrate dev` reconciles them away from whichever
-- database it is pointed at — not through the migration files, which are hand-corrected, but against the developer's
-- own database as it runs. This migration puts them back wherever they have gone missing and is a no-op everywhere
-- else. A unit test asserts they exist; when it fails, run this. (See also the review_fixes migration.)
CREATE INDEX IF NOT EXISTS "Photo_searchVector_idx" ON "Photo" USING GIN ("searchVector");
CREATE INDEX IF NOT EXISTS "Photo_searchVectorMembers_idx" ON "Photo" USING GIN ("searchVectorMembers");
CREATE INDEX IF NOT EXISTS "Photo_embedding_idx" ON "Photo" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "Photo_textEmbedding_idx" ON "Photo" USING hnsw ("textEmbedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "Face_embedding_idx" ON "Face" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "AnimalDetection_embedding_idx" ON "AnimalDetection" USING hnsw ("embedding" vector_cosine_ops);
