-- Hand-written: origins whose loop finished before the run-control columns existed but whose batch was still open at the time.
UPDATE "AnnotationBatch" SET "runEndedAt" = COALESCE("endedAt", now()) WHERE "parentId" IS NULL AND "runEndedAt" IS NULL AND (status <> 'SUBMITTED' OR "anthropicBatchId" NOT LIKE 'pending-%');
