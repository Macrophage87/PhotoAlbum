-- Image URLs are versioned by what they serve, not by the row's updatedAt: a forget's rewrite of a photo's text moved
-- updatedAt, and so every public image URL of exactly the photos it covered, in the same millisecond.
ALTER TABLE "Photo" ADD COLUMN "imageVersion" INTEGER NOT NULL DEFAULT 0;

-- Bumped whenever what the photo's addresses serve, or who may fetch them, changes: its files, its edits, its state,
-- which trip or activity it is in (and so who may see it). Text never moves it.
CREATE OR REPLACE FUNCTION photo_image_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.renditions IS DISTINCT FROM OLD.renditions
     OR NEW."videoRenditions" IS DISTINCT FROM OLD."videoRenditions"
     OR NEW.edits IS DISTINCT FROM OLD.edits
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW."trashedAt" IS DISTINCT FROM OLD."trashedAt"
     OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey"
     OR NEW."originalPath" IS DISTINCT FROM OLD."originalPath"
     OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
     OR NEW.width IS DISTINCT FROM OLD.width
     OR NEW.height IS DISTINCT FROM OLD.height
     OR NEW."tripId" IS DISTINCT FROM OLD."tripId"
     OR NEW."activityId" IS DISTINCT FROM OLD."activityId" THEN
    NEW."imageVersion" := OLD."imageVersion" + 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS photo_image_version_trigger ON "Photo";
CREATE TRIGGER photo_image_version_trigger BEFORE UPDATE ON "Photo" FOR EACH ROW EXECUTE FUNCTION photo_image_version();

-- Forgets stamped namesScrubbedAt on exactly the photos they covered, with the same value as AppSetting.lastForgetAt.
-- They no longer stamp (an answer asked for before any forget is thrown away instead), and the old stamps go: only
-- untagging and a withdrawn naming stamp from now on, and a missing stamp only means an answer is judged by the
-- global rule.
UPDATE "Photo" SET "namesScrubbedAt" = NULL WHERE "namesScrubbedAt" IS NOT NULL;
