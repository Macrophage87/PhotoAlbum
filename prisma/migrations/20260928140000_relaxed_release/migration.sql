-- Words shown to everyone only because the relaxed name check excused them (the strict check would have held them
-- then) are marked where they are, per field: an item's words, its place guess, and the helper's description of a
-- trip, an activity or a collection. Only those are checked again when a level, a place or who may be named changes
-- (src/lib/annotation/rejudge.ts, rejudgeNameCheck); that replaces the album-wide tightening stamps, which could not
-- say which words the excuses let out. Nothing was released so before this, so nothing is marked here.
ALTER TABLE "Photo" ADD COLUMN "relaxedReleaseAt" TIMESTAMP(3), ADD COLUMN "placeRelaxedReleaseAt" TIMESTAMP(3);
ALTER TABLE "Trip" ADD COLUMN "relaxedReleaseAt" TIMESTAMP(3);
ALTER TABLE "Activity" ADD COLUMN "relaxedReleaseAt" TIMESTAMP(3);
ALTER TABLE "Collection" ADD COLUMN "relaxedReleaseAt" TIMESTAMP(3);
ALTER TABLE "AppSetting" DROP COLUMN "nameCheckTightenedAt", DROP COLUMN "nameCheckRecheckedAt";

-- The re-check asks for the marked ones, every night too; most never are.
CREATE INDEX "Photo_relaxedRelease_idx" ON "Photo"("id") WHERE "relaxedReleaseAt" IS NOT NULL OR "placeRelaxedReleaseAt" IS NOT NULL;
