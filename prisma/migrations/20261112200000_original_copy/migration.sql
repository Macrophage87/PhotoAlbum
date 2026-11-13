-- Option 2 storage: where each original is kept once moved off the server's disk to S3.
CREATE TABLE "OriginalCopy" (
    "photoId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "storageClass" TEXT NOT NULL,
    "storedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OriginalCopy_pkey" PRIMARY KEY ("photoId")
);

ALTER TABLE "OriginalCopy" ADD CONSTRAINT "OriginalCopy_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
