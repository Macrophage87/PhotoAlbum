-- Hand-written (Prisma would re-emit drops for the indexes it cannot see on Unsupported columns).
ALTER TABLE "AnnotationBatch" ADD COLUMN "canceled" INTEGER NOT NULL DEFAULT 0;
-- Runs from before the run-control columns existed are over: give them an end so the admin page does not offer to stop them.
UPDATE "AnnotationBatch" SET "runEndedAt" = COALESCE("endedAt", now()) WHERE "parentId" IS NULL AND status <> 'SUBMITTED' AND "runEndedAt" IS NULL;
