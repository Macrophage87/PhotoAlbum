-- One photograph may be the cover of any number of trips, collections and activities: a picture that sits in two
-- collections can lead both, and one moved between trips no longer blocks its new trip while the old one still
-- points at it. Whether a cover still stands is decided where it is read. Dropping a unique index cannot fail on
-- existing rows; a plain index keeps "who is this photograph the cover of" (and ON DELETE SET NULL) quick.
DROP INDEX "Trip_coverPhotoId_key";
CREATE INDEX "Trip_coverPhotoId_idx" ON "Trip"("coverPhotoId");

DROP INDEX "Collection_coverPhotoId_key";
CREATE INDEX "Collection_coverPhotoId_idx" ON "Collection"("coverPhotoId");

DROP INDEX "Activity_coverPhotoId_key";
CREATE INDEX "Activity_coverPhotoId_idx" ON "Activity"("coverPhotoId");
