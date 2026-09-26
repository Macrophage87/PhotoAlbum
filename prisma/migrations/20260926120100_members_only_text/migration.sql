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
ADD COLUMN     "membersTitle" TEXT;

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

-- What is already described cannot say what it was given, so it is judged by what it could have been given: notes,
-- anybody tagged in it, or the text naming anybody the album knows. Erring towards members-only only costs a
-- stranger a description.
UPDATE "Photo" p SET "annotationMembersOnly" = true
WHERE p.annotation IS NOT NULL AND (
  NULLIF(btrim(p.context), '') IS NOT NULL
  OR EXISTS (SELECT 1 FROM "Face" f WHERE f."photoId" = p.id AND f."personId" IS NOT NULL)
  OR EXISTS (SELECT 1 FROM "AnimalDetection" a WHERE a."photoId" = p.id AND a."personId" IS NOT NULL)
  OR EXISTS (
    SELECT 1 FROM (SELECT regexp_split_to_table(n.name, '[^[:alnum:]]+') AS word FROM (SELECT name FROM "Person" UNION SELECT name FROM "User" WHERE name IS NOT NULL) n) w
    WHERE length(w.word) >= 2
      AND concat_ws(' ', p.annotation->>'title', p.annotation->>'caption', p.annotation->>'description', p.annotation->>'searchSummary', p.annotation->>'place', p.annotation->>'tags') ~* ('\m' || w.word || '\M')
  )
);

-- A description already written cannot say whether the helper wrote it, or from what; one that names anybody the
-- album knows is kept for members, which is the part that matters.
CREATE TEMP TABLE known_name_words AS
  SELECT DISTINCT lower(w) AS word FROM (SELECT regexp_split_to_table(name, '[^[:alnum:]]+') AS w FROM (SELECT name FROM "Person" UNION SELECT name FROM "User" WHERE name IS NOT NULL) n) x
  WHERE length(w) >= 2;
UPDATE "Trip" c SET "descriptionMembersOnly" = true WHERE c.description IS NOT NULL AND EXISTS (SELECT 1 FROM known_name_words k WHERE c.description ~* ('\m' || k.word || '\M'));
UPDATE "Collection" c SET "descriptionMembersOnly" = true WHERE c.description IS NOT NULL AND EXISTS (SELECT 1 FROM known_name_words k WHERE c.description ~* ('\m' || k.word || '\M'));
UPDATE "Activity" c SET "descriptionMembersOnly" = true WHERE c.description IS NOT NULL AND EXISTS (SELECT 1 FROM known_name_words k WHERE c.description ~* ('\m' || k.word || '\M'));
DROP TABLE known_name_words;

-- The helper's title went on the photograph wherever it had none; where that title is members-only it moves.
UPDATE "Photo" SET "membersTitle" = NULLIF(btrim(annotation->>'title'), '') WHERE "annotationMembersOnly" AND kind <> 'EXTERNAL_VIDEO';
UPDATE "Photo" SET title = NULL WHERE "annotationMembersOnly" AND kind <> 'EXTERNAL_VIDEO' AND title IS NOT NULL AND btrim(title) = btrim(annotation->>'title');

-- A no-op update re-runs the BEFORE trigger, so every photograph is re-indexed under the new split.
UPDATE "Photo" SET "updatedAt" = "updatedAt";
