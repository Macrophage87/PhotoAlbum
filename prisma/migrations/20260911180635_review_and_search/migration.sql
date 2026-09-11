-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "context" TEXT,
ADD COLUMN     "contextUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "searchVector" tsvector,
ADD COLUMN     "searchVectorMembers" tsvector;

-- CreateIndex
CREATE INDEX "Photo_reviewedAt_idx" ON "Photo"("reviewedAt");

-- Full-text search vectors, maintained by triggers.
-- "searchVector" holds caption, title, context and container titles: the only column anonymous search queries.
-- "searchVectorMembers" adds the uploader's name (later: people's and pets' names) and is queried for members only.
CREATE OR REPLACE FUNCTION photo_search_base(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('english', coalesce(p.caption, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.title, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.context, '')), 'B')
      || setweight(to_tsvector('english', coalesce((SELECT t.title FROM "Trip" t WHERE t.id = p."tripId"), '')), 'C')
      || setweight(to_tsvector('english', coalesce((SELECT string_agg(c.title, ' ') FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" WHERE ci."photoId" = p.id), '')), 'C');
$$;

CREATE OR REPLACE FUNCTION photo_search_members_extra(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('simple', coalesce((SELECT u.name FROM "User" u WHERE u.id = p."uploaderId"), '')), 'C');
$$;

CREATE OR REPLACE FUNCTION photo_search_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := photo_search_base(NEW);
  NEW."searchVectorMembers" := photo_search_base(NEW) || photo_search_members_extra(NEW);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS photo_search_trigger ON "Photo";
CREATE TRIGGER photo_search_trigger BEFORE INSERT OR UPDATE ON "Photo"
  FOR EACH ROW EXECUTE FUNCTION photo_search_before_write();

-- A no-op update re-runs the BEFORE trigger for every photo a container or member change touches.
CREATE OR REPLACE FUNCTION photo_search_refresh_by_collection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE id = COALESCE(NEW."photoId", OLD."photoId");
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS collection_item_search_trigger ON "CollectionItem";
CREATE TRIGGER collection_item_search_trigger AFTER INSERT OR DELETE ON "CollectionItem"
  FOR EACH ROW EXECUTE FUNCTION photo_search_refresh_by_collection();

CREATE OR REPLACE FUNCTION photo_search_refresh_collection_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE id IN (SELECT "photoId" FROM "CollectionItem" WHERE "collectionId" = NEW.id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS collection_title_search_trigger ON "Collection";
CREATE TRIGGER collection_title_search_trigger AFTER UPDATE ON "Collection"
  FOR EACH ROW EXECUTE FUNCTION photo_search_refresh_collection_title();

CREATE OR REPLACE FUNCTION photo_search_refresh_trip_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE "tripId" = NEW.id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trip_title_search_trigger ON "Trip";
CREATE TRIGGER trip_title_search_trigger AFTER UPDATE ON "Trip"
  FOR EACH ROW EXECUTE FUNCTION photo_search_refresh_trip_title();

CREATE OR REPLACE FUNCTION photo_search_refresh_user_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE "uploaderId" = NEW.id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS user_name_search_trigger ON "User";
CREATE TRIGGER user_name_search_trigger AFTER UPDATE ON "User"
  FOR EACH ROW EXECUTE FUNCTION photo_search_refresh_user_name();

CREATE INDEX "Photo_searchVector_idx" ON "Photo" USING GIN ("searchVector");
CREATE INDEX "Photo_searchVectorMembers_idx" ON "Photo" USING GIN ("searchVectorMembers");

-- Fill in existing rows.
UPDATE "Photo" SET "updatedAt" = "updatedAt";
