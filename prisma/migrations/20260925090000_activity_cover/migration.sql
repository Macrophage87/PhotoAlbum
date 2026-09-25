-- An activity's own cover photograph, chosen by hand; forgotten if the photograph is deleted.
ALTER TABLE "Activity" ADD COLUMN "coverPhotoId" TEXT;

CREATE UNIQUE INDEX "Activity_coverPhotoId_key" ON "Activity"("coverPhotoId");

ALTER TABLE "Activity" ADD CONSTRAINT "Activity_coverPhotoId_fkey" FOREIGN KEY ("coverPhotoId") REFERENCES "Photo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
