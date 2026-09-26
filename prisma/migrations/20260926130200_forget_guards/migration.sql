-- What forgetting somebody needs to know to do it properly.
--
-- Photo.namesScrubbedAt: when a forgotten name was last taken out of the helper's text on an item, so an answer to
-- a request built before then (a batch takes hours) is thrown away instead of writing the name back.
-- Photo.titleByHelper: whether the title an item goes by is the helper's, even after the helper has since written
-- another one; only the helper's words are rewritten when somebody is forgotten.
-- Person.formerNames: a renamed person is still in text written under the old name.
-- Person.namingWithdrawnAt: see below.
-- Person.namesChangedAt: see the trigger below.
-- descriptionByHelper: which trip, collection and activity descriptions are the helper's words; nobody recorded it
-- before, so every existing description counts as a member's.
ALTER TABLE "Photo" ADD COLUMN "namesScrubbedAt" TIMESTAMP(3),
  ADD COLUMN "titleByHelper" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Person" ADD COLUMN "formerNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "namingWithdrawnAt" TIMESTAMP(3),
  ADD COLUMN "namesChangedAt" TIMESTAMP(3);
ALTER TABLE "Trip" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Collection" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Activity" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;

-- Only what decides whether, or as what, somebody may be named: a relationship edit or the nightly "needs a
-- decision" flag must not throw away the helper's answers about them.
CREATE OR REPLACE FUNCTION person_names_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW."formerNames" IS DISTINCT FROM OLD."formerNames"
     OR NEW."optedOutAt" IS DISTINCT FROM OLD."optedOutAt" OR NEW."nameInDescriptions" IS DISTINCT FROM OLD."nameInDescriptions"
     OR NEW."faceIndexing" IS DISTINCT FROM OLD."faceIndexing" OR NEW.birthday IS DISTINCT FROM OLD.birthday
     OR NEW."adultAttestedAt" IS DISTINCT FROM OLD."adultAttestedAt" THEN
    NEW."namesChangedAt" := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS person_names_changed_trigger ON "Person";
CREATE TRIGGER person_names_changed_trigger BEFORE UPDATE ON "Person"
  FOR EACH ROW EXECUTE FUNCTION person_names_changed();

-- Naming somebody needs evidence they are an adult: a birthday showing 18 or older, or an admin's confirmation.
-- Anybody named without it could be a child, so the agreement is switched off at once and nothing more is sent. The
-- names already written into the helper's text wait (see Person.namingWithdrawnAt): admins are shown who, and can
-- record the evidence to keep them. People whose naming was turned off before turning it off scrubbed anything are
-- in the same position and are listed too. A person with no birthday and no confirmation is never "an adult"
-- (NULL is not true), which is the case this exists for.
CREATE OR REPLACE FUNCTION withdraw_unevidenced_naming() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE "Person" SET "namingWithdrawnAt" = now()
  WHERE kind = 'HUMAN' AND "optedOutAt" IS NULL AND "namingWithdrawnAt" IS NULL
    AND ("nameInDescriptions" OR "faceIndexing" OR "nameInDescriptionsSetAt" IS NOT NULL)
    AND NOT COALESCE(("nameInDescriptions" OR "faceIndexing")
      AND (birthday <= (now() - interval '18 years') OR (birthday IS NULL AND "adultAttestedAt" IS NOT NULL)), false);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE "Person" SET "nameInDescriptions" = false
  WHERE kind = 'HUMAN' AND "nameInDescriptions"
    AND NOT COALESCE(birthday <= (now() - interval '18 years') OR (birthday IS NULL AND "adultAttestedAt" IS NOT NULL), false);
  RETURN n;
END $$;
SELECT withdraw_unevidenced_naming();

-- Whose title an item goes by. The helper's while it is the one its record gives; otherwise the helper's if one of
-- its kept answers gave that title; otherwise, for an item whose description no member has edited, the helper's if
-- the title names somebody the album knows, since the helper was told names and members' titles rarely changed.
CREATE OR REPLACE FUNCTION answer_title(response jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN btrim(((response->'content'->0->>'text')::jsonb)->>'title');
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;
UPDATE "Photo" p SET "titleByHelper" = true
WHERE COALESCE(NULLIF(btrim(p.title), ''), NULLIF(btrim(p."membersTitle"), '')) IS NOT NULL AND p.annotation IS NOT NULL AND (
  btrim(COALESCE(NULLIF(btrim(p.title), ''), p."membersTitle")) = btrim(p.annotation->>'title')
  OR EXISTS (SELECT 1 FROM "MediaAnnotationRaw" r WHERE r."photoId" = p.id AND answer_title(r.response) = btrim(COALESCE(NULLIF(btrim(p.title), ''), p."membersTitle")))
  OR (p."annotationSource" = 'MACHINE' AND COALESCE(NULLIF(btrim(p.title), ''), p."membersTitle") ~* (SELECT name_regex(array_agg(name)) FROM "Person"))
);
DROP FUNCTION answer_title(jsonb);
