-- What a stranger may read, and search, of a photograph.
--
-- Anonymous visitors never see people's names, uploaders' names or the uploader's notes. The helper is handed
-- exactly those — the names the family confirmed, and the notes — and writes them into its title, caption,
-- description, tags and search summary, which were then shown to and indexed for everybody. Its text is now kept
-- for members whenever it was written from anything members-only, and so is the title it would otherwise have put
-- on the photograph.
--
-- The anonymous column also stops carrying the notes, and carries a trip's or a collection's title only while that
-- trip or collection is public: a private trip's title is members-only, and a word from it must not pick out which
-- public photographs were taken on it.

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "annotationMembersOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "membersTitle" TEXT,
ADD COLUMN     "placeEstimateMembersOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "descriptionMembersOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "descriptionMembersOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "descriptionMembersOnly" BOOLEAN NOT NULL DEFAULT false;

-- The helper's text, indexed the same way in whichever column it belongs to.
CREATE OR REPLACE FUNCTION photo_search_annotation(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('english', coalesce(p.annotation->>'caption', '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'description', '')), 'B')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'place', '')), 'B')
      || setweight(to_tsvector('english', coalesce((SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.annotation->'tags') = 'array' THEN p.annotation->'tags' ELSE '[]'::jsonb END) t), '')), 'B')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'searchSummary', '')), 'C');
$$;

-- What a stranger may search: the family's caption and title, the place, the helper's text when it was written from
-- nothing members-only, and the titles of public trips and collections.
CREATE OR REPLACE FUNCTION photo_search_base(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('english', coalesce(p.caption, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.title, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p."placeName", '')), 'B')
      || setweight(to_tsvector('simple', coalesce(p."placeName", '')), 'B')
      || CASE WHEN p."annotationMembersOnly" THEN ''::tsvector ELSE photo_search_annotation(p) END
      || setweight(to_tsvector('english', coalesce((SELECT t.title FROM "Trip" t WHERE t.id = p."tripId" AND t.visibility = 'PUBLIC'), '')), 'C')
      || setweight(to_tsvector('english', coalesce((SELECT string_agg(c.title, ' ') FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" WHERE ci."photoId" = p.id AND c.visibility = 'PUBLIC'), '')), 'C');
$$;

-- Everything else members may search: who uploaded it, who is in it, the notes, the helper's text when it was
-- written from any of those, and the titles of trips and collections that are not public.
CREATE OR REPLACE FUNCTION photo_search_members_extra(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('simple', coalesce((SELECT u.name FROM "User" u WHERE u.id = p."uploaderId"), '')), 'C')
      || setweight(to_tsvector('simple', coalesce((SELECT string_agg(DISTINCT pe.name, ' ') FROM "Face" f JOIN "Person" pe ON pe.id = f."personId" WHERE f."photoId" = p.id AND f.status = 'CONFIRMED' AND pe."optedOutAt" IS NULL), '')), 'A')
      || setweight(to_tsvector('simple', coalesce((SELECT string_agg(DISTINCT pe.name, ' ') FROM "AnimalDetection" a JOIN "Person" pe ON pe.id = a."personId" WHERE a."photoId" = p.id AND a.status = 'CONFIRMED'), '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.context, '')), 'B')
      || setweight(to_tsvector('english', coalesce(p."membersTitle", '')), 'A')
      || CASE WHEN p."annotationMembersOnly" THEN photo_search_annotation(p) ELSE ''::tsvector END
      || setweight(to_tsvector('english', coalesce((SELECT t.title FROM "Trip" t WHERE t.id = p."tripId" AND t.visibility <> 'PUBLIC'), '')), 'C')
      || setweight(to_tsvector('english', coalesce((SELECT string_agg(c.title, ' ') FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" WHERE ci."photoId" = p.id AND c.visibility <> 'PUBLIC'), '')), 'C');
$$;

-- The base column is part of the members' one, so it is worked out once rather than twice for every write.
CREATE OR REPLACE FUNCTION photo_search_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base tsvector;
BEGIN
  base := photo_search_base(NEW);
  NEW."searchVector" := base;
  NEW."searchVectorMembers" := base || photo_search_members_extra(NEW);
  RETURN NEW;
END $$;

-- A trip or collection going public (or private) moves its title between the two columns.
CREATE OR REPLACE FUNCTION photo_search_refresh_trip_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE "tripId" = NEW.id;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION photo_search_refresh_collection_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE id IN (SELECT "photoId" FROM "CollectionItem" WHERE "collectionId" = NEW.id);
  END IF;
  RETURN NULL;
END $$;

-- Recognising a name in a sentence. Mirrors `namePatterns` and `mentionsAnyName` in src/lib/annotation/members-only.ts:
-- the whole name, and its first word when that is a given name of three letters or more (not "van" or "de"), as
-- whole words, with a possessive or a plural allowed. Accents are left as they are here; the application folds them.
CREATE OR REPLACE FUNCTION name_patterns(name text) RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $$
  SELECT pattern FROM (SELECT array_remove(regexp_split_to_array(lower(coalesce(name, '')), '[^[:alnum:]]+'), '') AS w) x,
  LATERAL (
    SELECT array_to_string(x.w, '[^[:alnum:]]+') AS pattern WHERE length(array_to_string(x.w, '')) >= 2
    UNION ALL
    SELECT x.w[1] WHERE cardinality(x.w) > 1 AND length(x.w[1]) >= 3
      AND NOT (x.w[1] = ANY (ARRAY['de', 'la', 'le', 'da', 'di', 'du', 'st', 'van', 'von', 'der', 'den', 'del', 'della', 'dos', 'das', 'des', 'san', 'santa', 'saint', 'ste']))
  ) p
$$;

-- One pattern for all of them, so a table is read once against one compiled expression. Null when there are none.
CREATE OR REPLACE FUNCTION name_regex(names text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '\m(' || string_agg(DISTINCT p, '|') || ')(''s|’s|s)?\M' FROM unnest(names) n, LATERAL name_patterns(n) p
$$;

-- The words of titles strangers cannot read, as `mentionsAnyTitle` has them: four letters or more, not a number, not
-- a word every title has.
CREATE OR REPLACE FUNCTION title_regex(titles text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '\m(' || string_agg(DISTINCT w, '|') || ')(''s|’s|s)?\M'
  FROM unnest(titles) t, LATERAL regexp_split_to_table(lower(coalesce(t, '')), '[^[:alnum:]]+') w
  WHERE length(w) >= 4 AND w !~ '^[0-9]+$'
    AND NOT (w = ANY (ARRAY['with', 'from', 'this', 'that', 'trip', 'week', 'weekend', 'photos', 'photo', 'pictures', 'family', 'holiday', 'vacation', 'visit', 'summer', 'winter', 'spring', 'autumn', 'fall', 'days', 'into', 'over', 'around']))
$$;

-- Everything the helper wrote about a photograph that anybody could read.
CREATE OR REPLACE FUNCTION photo_helper_text(p "Photo") RETURNS text LANGUAGE sql STABLE AS $$
  SELECT concat_ws(' ', p.annotation->>'title', p.annotation->>'caption', p.annotation->>'description', p.annotation->>'searchSummary', p.annotation->>'place', p.annotation->>'tags')
$$;

-- Text that names somebody goes members-only, wherever it is: the helper's text on a photograph (and the title it
-- gave, or any title naming them, moves to "membersTitle"), its guess at a place, and trip, collection and activity
-- descriptions. Called when a name first becomes known or changes, so what was written before somebody was added to
-- the album is judged by the same rule as what is written after.
CREATE OR REPLACE FUNCTION flag_named_text(rx text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF rx IS NULL THEN RETURN; END IF;
  UPDATE "Photo" p SET
    "annotationMembersOnly" = true,
    "membersTitle" = CASE
      WHEN p.kind = 'EXTERNAL_VIDEO' THEN p."membersTitle"
      WHEN p.title IS NOT NULL AND (p.title ~* rx OR btrim(p.title) = btrim(p.annotation->>'title')) THEN COALESCE(NULLIF(btrim(p."membersTitle"), ''), p.title)
      ELSE COALESCE(NULLIF(btrim(p."membersTitle"), ''), NULLIF(btrim(p.annotation->>'title'), '')) END,
    title = CASE WHEN p.kind <> 'EXTERNAL_VIDEO' AND p.title IS NOT NULL AND (p.title ~* rx OR btrim(p.title) = btrim(p.annotation->>'title')) THEN NULL ELSE p.title END
  WHERE p.annotation IS NOT NULL AND (photo_helper_text(p) ~* rx OR (p.kind <> 'EXTERNAL_VIDEO' AND p.title ~* rx));
  UPDATE "Photo" SET "placeEstimateMembersOnly" = true WHERE NOT "placeEstimateMembersOnly" AND "gpsSource" = 'ESTIMATE' AND concat_ws(' ', "placeEstimateName", "placeEstimateNote") ~* rx;
  UPDATE "Trip" SET "descriptionMembersOnly" = true WHERE NOT "descriptionMembersOnly" AND description ~* rx;
  UPDATE "Collection" SET "descriptionMembersOnly" = true WHERE NOT "descriptionMembersOnly" AND description ~* rx;
  UPDATE "Activity" SET "descriptionMembersOnly" = true WHERE NOT "descriptionMembersOnly" AND description ~* rx;
END $$;

CREATE OR REPLACE FUNCTION members_only_on_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name THEN
    PERFORM flag_named_text(name_regex(ARRAY[NEW.name]));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS person_name_members_only ON "Person";
CREATE TRIGGER person_name_members_only AFTER INSERT OR UPDATE OF name ON "Person"
  FOR EACH ROW EXECUTE FUNCTION members_only_on_name();
DROP TRIGGER IF EXISTS user_name_members_only ON "User";
CREATE TRIGGER user_name_members_only AFTER INSERT OR UPDATE OF name ON "User"
  FOR EACH ROW EXECUTE FUNCTION members_only_on_name();

-- What is already described cannot say what it was given, so it is judged by what it could have been given — notes,
-- anybody tagged in it — and by what it says: a name the album knows, or a word from the title of a trip or
-- collection strangers cannot open. Erring towards members-only only costs a stranger a description. One pass over
-- every photograph, which also re-indexes it under the new split, and one compiled pattern for all the names.
-- Rebuilding the two text indexes afterwards is several times quicker than keeping them up to date through a write
-- to every row, and this has to finish well inside a deploy's health check.
DROP INDEX IF EXISTS "Photo_searchVector_idx";
DROP INDEX IF EXISTS "Photo_searchVectorMembers_idx";

DO $$
DECLARE
  rx text;
  helper int; titles int; places int; trips int; collections int; activities int;
BEGIN
  SELECT name_regex(array_agg(name)) INTO rx FROM (SELECT name FROM "Person" UNION SELECT name FROM "User" WHERE name IS NOT NULL) n;

  UPDATE "Photo" p SET
    "annotationMembersOnly" = j.flag,
    "membersTitle" = CASE WHEN NOT j.flag OR p.kind = 'EXTERNAL_VIDEO' THEN NULL WHEN j.move THEN p.title ELSE NULLIF(btrim(p.annotation->>'title'), '') END,
    title = CASE WHEN j.flag AND j.move THEN NULL ELSE p.title END,
    "placeEstimateMembersOnly" = p."gpsSource" IS NOT DISTINCT FROM 'ESTIMATE' AND (j.flag OR NULLIF(btrim(p.context), '') IS NOT NULL
      OR COALESCE(concat_ws(' ', p."placeEstimateName", p."placeEstimateNote") ~* rx, false)
      OR COALESCE(concat_ws(' ', p."placeEstimateName", p."placeEstimateNote") ~* j.trx, false))
  FROM (
    SELECT q.id, t.trx,
      q.annotation IS NOT NULL AND (
        NULLIF(btrim(q.context), '') IS NOT NULL
        OR EXISTS (SELECT 1 FROM "Face" f WHERE f."photoId" = q.id AND f."personId" IS NOT NULL)
        OR EXISTS (SELECT 1 FROM "AnimalDetection" a WHERE a."photoId" = q.id AND a."personId" IS NOT NULL)
        OR COALESCE(photo_helper_text(q) ~* rx, false)
        OR COALESCE(photo_helper_text(q) ~* t.trx, false)) AS flag,
      q.kind <> 'EXTERNAL_VIDEO' AND q.title IS NOT NULL AND (btrim(q.title) IS NOT DISTINCT FROM btrim(q.annotation->>'title') OR COALESCE(q.title ~* rx, false)) AS move
    FROM "Photo" q,
    LATERAL (SELECT title_regex(ARRAY(
      SELECT tr.title FROM "Trip" tr WHERE tr.id = q."tripId" AND tr.visibility <> 'PUBLIC'
      UNION ALL
      SELECT c.title FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" WHERE ci."photoId" = q.id AND c.visibility <> 'PUBLIC')) AS trx) t
  ) j
  WHERE j.id = p.id;

  -- A description cannot say whether the helper wrote it either; one that names anybody the album knows is kept for
  -- members, and so is an activity's that repeats a word of its trip's title while the trip is not public.
  UPDATE "Trip" SET "descriptionMembersOnly" = true WHERE description ~* rx;
  UPDATE "Collection" SET "descriptionMembersOnly" = true WHERE description ~* rx;
  UPDATE "Activity" a SET "descriptionMembersOnly" = true FROM "Trip" t
    WHERE t.id = a."tripId" AND (a.description ~* rx OR (t.visibility <> 'PUBLIC' AND a.description ~* title_regex(ARRAY[t.title])));

  SELECT count(*) FILTER (WHERE "annotationMembersOnly"), count(*) FILTER (WHERE "membersTitle" IS NOT NULL AND title IS NULL), count(*) FILTER (WHERE "placeEstimateMembersOnly")
    INTO helper, titles, places FROM "Photo";
  SELECT count(*) INTO trips FROM "Trip" WHERE "descriptionMembersOnly";
  SELECT count(*) INTO collections FROM "Collection" WHERE "descriptionMembersOnly";
  SELECT count(*) INTO activities FROM "Activity" WHERE "descriptionMembersOnly";
  RAISE NOTICE 'members_only_text: helper text kept for members on % photographs (% titles moved to membersTitle), % place guesses; descriptions kept for members on % trips, % collections, % activities',
    helper, titles, places, trips, collections, activities;
END $$;

CREATE INDEX IF NOT EXISTS "Photo_searchVector_idx" ON "Photo" USING GIN ("searchVector");
CREATE INDEX IF NOT EXISTS "Photo_searchVectorMembers_idx" ON "Photo" USING GIN ("searchVectorMembers");
