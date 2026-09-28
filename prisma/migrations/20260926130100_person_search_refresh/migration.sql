-- Renaming somebody re-indexes every photograph they are on, by either route.
--
-- The members' search column takes names from confirmed faces and from confirmed animal matches, but a rename only
-- re-indexed the photographs with a face row, so a dog the matcher had found kept its old name in search on every
-- one of those. Opting out, or agreeing again, changes whether the name is indexed at all, and now re-indexes too.
CREATE OR REPLACE FUNCTION photo_search_refresh_person_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW."optedOutAt" IS DISTINCT FROM OLD."optedOutAt" THEN
    UPDATE "Photo" SET "updatedAt" = "updatedAt"
      WHERE id IN (SELECT "photoId" FROM "Face" WHERE "personId" = NEW.id UNION SELECT "photoId" FROM "AnimalDetection" WHERE "personId" = NEW.id);
  END IF;
  RETURN NULL;
END $$;

-- Photographs a renamed pet was matched on may still carry the old name.
UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE id IN (SELECT "photoId" FROM "AnimalDetection" WHERE "personId" IS NOT NULL AND status = 'CONFIRMED');
