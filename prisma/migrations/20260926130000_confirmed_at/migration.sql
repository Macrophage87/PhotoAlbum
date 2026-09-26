-- When a face or an animal became somebody, as distinct from when it was found.
--
-- The names run asks which descriptions were written before the album knew who was in the photograph. It compared
-- the description's time with the face's createdAt, which is when the detector found the face: usually before the
-- description, while the member's "yes, that is Ada" comes days later as an update to the same row. So only hand
-- tags, which are new rows, ever brought a photograph into the run.
--
-- Set by trigger rather than in each action, because a face becomes confirmed from half a dozen places (a proposal
-- accepted, a group named, a face named by hand, a tag, a pet claimed, an animal match accepted) and every one of
-- them must move it.
ALTER TABLE "Face" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "AnimalDetection" ADD COLUMN "confirmedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION set_confirmed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status::text <> 'CONFIRMED' OR NEW."personId" IS NULL THEN
    NEW."confirmedAt" := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    -- A row born confirmed (a hand tag) was confirmed when it was made.
    NEW."confirmedAt" := COALESCE(NEW."confirmedAt", NEW."createdAt", now());
  ELSIF OLD.status::text IS DISTINCT FROM 'CONFIRMED' OR OLD."personId" IS DISTINCT FROM NEW."personId" THEN
    NEW."confirmedAt" := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS face_confirmed_at_trigger ON "Face";
CREATE TRIGGER face_confirmed_at_trigger BEFORE INSERT OR UPDATE OF status, "personId" ON "Face"
  FOR EACH ROW EXECUTE FUNCTION set_confirmed_at();
DROP TRIGGER IF EXISTS animal_confirmed_at_trigger ON "AnimalDetection";
CREATE TRIGGER animal_confirmed_at_trigger BEFORE INSERT OR UPDATE OF status, "personId" ON "AnimalDetection"
  FOR EACH ROW EXECUTE FUNCTION set_confirmed_at();

-- Existing rows: nobody recorded when they were confirmed. Where the photograph was described after the face was
-- found and the description does not say the person's name, the confirmation may well have come after it, which
-- is the case the run exists for; those count as confirmed now, and everything else as confirmed when found.
UPDATE "Face" f SET "confirmedAt" = f."createdAt" WHERE f.status = 'CONFIRMED' AND f."personId" IS NOT NULL;
UPDATE "AnimalDetection" a SET "confirmedAt" = a."createdAt" WHERE a.status = 'CONFIRMED' AND a."personId" IS NOT NULL;
UPDATE "Face" f SET "confirmedAt" = now()
  FROM "Photo" p, "Person" pe
  WHERE p.id = f."photoId" AND pe.id = f."personId" AND f.status = 'CONFIRMED' AND f.confidence > 0
    AND p."annotatedAt" IS NOT NULL AND p."annotatedAt" > f."createdAt"
    AND position(lower(pe.name) IN lower(coalesce(p.annotation::text, ''))) = 0;
UPDATE "AnimalDetection" a SET "confirmedAt" = now()
  FROM "Photo" p, "Person" pe
  WHERE p.id = a."photoId" AND pe.id = a."personId" AND a.status = 'CONFIRMED'
    AND p."annotatedAt" IS NOT NULL AND p."annotatedAt" > a."createdAt"
    AND position(lower(pe.name) IN lower(coalesce(p.annotation::text, ''))) = 0;
