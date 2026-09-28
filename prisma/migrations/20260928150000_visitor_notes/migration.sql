-- Notes visitors (and members) send the family from the album's "Send the family a note" page, read by admins only.
CREATE TABLE "VisitorNote" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "message" TEXT NOT NULL,
    "photoId" TEXT,
    "pageUrl" TEXT,
    "readAt" TIMESTAMP(3),
    "clientHash" TEXT NOT NULL,
    "unmailed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VisitorNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VisitorNote_createdAt_idx" ON "VisitorNote"("createdAt");
CREATE INDEX "VisitorNote_clientHash_createdAt_idx" ON "VisitorNote"("clientHash", "createdAt");

ALTER TABLE "VisitorNote" ADD CONSTRAINT "VisitorNote_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The key the note form's timing token is signed with, made on first use.
ALTER TABLE "AppSetting" ADD COLUMN "noteFormKey" TEXT;
