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
ADD COLUMN     "annotationTitleOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "annotationSharedAt" TIMESTAMP(3),
ADD COLUMN     "placeEstimateMembersOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "descriptionMembersOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "descriptionSharedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "descriptionMembersOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "descriptionSharedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "descriptionMembersOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "descriptionTitleOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "descriptionSharedAt" TIMESTAMP(3);

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

-- What is already described cannot say what it was given, so it is judged here by what it could have been given:
-- the uploader's notes, or anybody tagged in it. What it says — a name the album knows, a word from a private trip's
-- title — is judged by the application (src/lib/annotation/rejudge.ts), which the worker runs over the whole album
-- when it starts, so the one matcher decides everywhere. Erring towards members-only only costs a stranger a
-- description. One pass over every photograph, which also re-indexes it under the new split.
--
-- Only the helper's own title moves: a title the family typed is theirs to publish, names and all.
DROP INDEX IF EXISTS "Photo_searchVector_idx";
DROP INDEX IF EXISTS "Photo_searchVectorMembers_idx";

DO $$
DECLARE helper int; titles int; places int;
BEGIN
  UPDATE "Photo" p SET
    "annotationMembersOnly" = j.flag,
    "membersTitle" = CASE WHEN j.flag AND p.kind <> 'EXTERNAL_VIDEO' THEN NULLIF(btrim(p.annotation->>'title'), '') END,
    title = CASE WHEN j.flag AND p.kind <> 'EXTERNAL_VIDEO' AND btrim(p.title) IS NOT DISTINCT FROM btrim(p.annotation->>'title') THEN NULL ELSE p.title END,
    "placeEstimateMembersOnly" = p."gpsSource" IS NOT DISTINCT FROM 'ESTIMATE' AND (j.flag OR NULLIF(btrim(p.context), '') IS NOT NULL)
  FROM (
    SELECT q.id, q.annotation IS NOT NULL AND (
        NULLIF(btrim(q.context), '') IS NOT NULL
        OR EXISTS (SELECT 1 FROM "Face" f WHERE f."photoId" = q.id AND f."personId" IS NOT NULL)
        OR EXISTS (SELECT 1 FROM "AnimalDetection" a WHERE a."photoId" = q.id AND a."personId" IS NOT NULL)) AS flag
    FROM "Photo" q
  ) j
  WHERE j.id = p.id;

  SELECT count(*) FILTER (WHERE "annotationMembersOnly"), count(*) FILTER (WHERE "membersTitle" IS NOT NULL AND title IS NULL), count(*) FILTER (WHERE "placeEstimateMembersOnly")
    INTO helper, titles, places FROM "Photo";
  RAISE NOTICE 'members_only_text: helper text kept for members on % photographs with notes or somebody tagged (% titles moved to membersTitle), % place guesses; names and private title words are judged when the worker starts',
    helper, titles, places;
END $$;

-- Rebuilding the two text indexes afterwards is several times quicker than keeping them up to date through a write
-- to every row, and this has to finish well inside a deploy's health check.
CREATE INDEX IF NOT EXISTS "Photo_searchVector_idx" ON "Photo" USING GIN ("searchVector");
CREATE INDEX IF NOT EXISTS "Photo_searchVectorMembers_idx" ON "Photo" USING GIN ("searchVectorMembers");
