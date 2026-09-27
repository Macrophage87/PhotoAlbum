-- Image URLs are versioned by what they serve, not by the row's updatedAt: a forget's rewrite of a photo's text moved
-- updatedAt, and so every public image URL of exactly the photos it covered, in the same millisecond.
ALTER TABLE "Photo" ADD COLUMN "imageVersion" INTEGER NOT NULL DEFAULT 0;

-- Bumped whenever what the photo's addresses serve, or who may fetch them, changes: its files, its edits, its state,
-- which trip or activity it is in (and so who may see it), and whenever a writer bumps it itself (new renditions
-- under the same file names, a collection's exposure). Text never moves it. Never back to a number used before: at
-- least the clock's seconds, so a restored backup or a reset row does not hand out an address a cache already holds
-- for other bytes.
CREATE OR REPLACE FUNCTION photo_image_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."imageVersion" IS DISTINCT FROM OLD."imageVersion"
     OR NEW.renditions IS DISTINCT FROM OLD.renditions
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
    NEW."imageVersion" := greatest(OLD."imageVersion" + 1, extract(epoch from clock_timestamp())::int);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS photo_image_version_trigger ON "Photo";
CREATE TRIGGER photo_image_version_trigger BEFORE UPDATE ON "Photo" FOR EACH ROW EXECUTE FUNCTION photo_image_version();

-- Forgets stamped namesScrubbedAt on exactly the photos they covered, with the same value as AppSetting.lastForgetAt.
-- They no longer stamp (an answer asked for before any forget is thrown away instead), and the old stamps go, all of
-- them: a stamp left from an untagging or a withdrawal would tell those apart from a forget's. What the stamps did
-- for an answer asked for before them, lastForgetAt does from now: set to now, every answer asked for before this
-- migration is thrown away (see forgetState). Only untagging and a withdrawn naming stamp from now on.
UPDATE "Photo" SET "namesScrubbedAt" = NULL WHERE "namesScrubbedAt" IS NOT NULL;
INSERT INTO "AppSetting" (id, "lastForgetAt", "updatedAt") VALUES ('app', now(), now())
  ON CONFLICT (id) DO UPDATE SET "lastForgetAt" = now();
