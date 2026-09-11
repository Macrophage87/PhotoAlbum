-- pgvector: the database image is pgvector/pgvector:pg16 (compose and CI).
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "Photo" ADD COLUMN "embedding" vector(512);
ALTER TABLE "Photo" ADD COLUMN "textEmbedding" vector(384);
ALTER TABLE "Photo" ADD COLUMN "embeddedAt" TIMESTAMP(3);

CREATE INDEX "Photo_embedding_idx" ON "Photo" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "Photo_textEmbedding_idx" ON "Photo" USING hnsw ("textEmbedding" vector_cosine_ops);
