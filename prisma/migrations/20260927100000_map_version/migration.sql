-- The map's version: one row, bumped whenever something any map shows changes (src/lib/map/cache.ts keeps worked-out
-- maps for as long as it stands). `version` counts every such change; `access` only those that can take something
-- off a map for somebody (a trip or collection made less visible, a photograph trashed, moved or deleted), for which
-- a kept map is never served while its replacement is being worked out.
CREATE TABLE "MapVersion" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" BIGINT NOT NULL DEFAULT 0,
    "access" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "MapVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MapVersion_one_row" CHECK ("id" = 1)
);
INSERT INTO "MapVersion" ("id") VALUES (1);

-- Once per transaction for each kind of change ('access' counts as both), and at commit: the triggers below are
-- deferred, so the row is taken only as the transaction finishes, after every other lock it takes, and the bump
-- becomes visible in the same instant as the change. A reader never sees the new version before the new data.
CREATE FUNCTION "map_version_bump"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind text := TG_ARGV[0];
  tx text := txid_current()::text;
  done text := coalesce(current_setting('photoalbum.map_bumped', true), '');
BEGIN
  IF done = tx || ':access' OR (kind = 'content' AND done = tx || ':content') THEN
    RETURN NULL;
  END IF;
  -- A transaction that has already moved the version for content moves only the access part when it takes something off.
  UPDATE "MapVersion" SET "version" = "version" + (CASE WHEN done = tx || ':content' THEN 0 ELSE 1 END), "access" = "access" + (CASE WHEN kind = 'access' THEN 1 ELSE 0 END) WHERE "id" = 1;
  PERFORM set_config('photoalbum.map_bumped', tx || ':' || kind, true);
  RETURN NULL;
END
$$;

-- Photographs: where, when, whether ready, whose and on what; in the trash or on another trip is less to see.
CREATE CONSTRAINT TRIGGER "Photo_map_added" AFTER INSERT ON "Photo" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('content');
CREATE CONSTRAINT TRIGGER "Photo_map_removed" AFTER DELETE ON "Photo" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('access');
CREATE CONSTRAINT TRIGGER "Photo_map_changed" AFTER UPDATE OF "lat", "lng", "status", "takenAt", "tzOffsetMin", "activityId", "uploaderId" ON "Photo" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."lat" IS DISTINCT FROM NEW."lat" OR OLD."lng" IS DISTINCT FROM NEW."lng" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."takenAt" IS DISTINCT FROM NEW."takenAt"
    OR OLD."tzOffsetMin" IS DISTINCT FROM NEW."tzOffsetMin" OR OLD."activityId" IS DISTINCT FROM NEW."activityId" OR OLD."uploaderId" IS DISTINCT FROM NEW."uploaderId")
  EXECUTE FUNCTION "map_version_bump"('content');
CREATE CONSTRAINT TRIGGER "Photo_map_access" AFTER UPDATE OF "trashedAt", "tripId" ON "Photo" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."trashedAt" IS DISTINCT FROM NEW."trashedAt" OR OLD."tripId" IS DISTINCT FROM NEW."tripId")
  EXECUTE FUNCTION "map_version_bump"('access');

-- Trips: who may see them, and what the map calls them, where it puts them in its list, and whose clock they keep.
CREATE CONSTRAINT TRIGGER "Trip_map_added" AFTER INSERT ON "Trip" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('content');
CREATE CONSTRAINT TRIGGER "Trip_map_removed" AFTER DELETE ON "Trip" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('access');
CREATE CONSTRAINT TRIGGER "Trip_map_access" AFTER UPDATE OF "visibility", "shareToken" ON "Trip" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."visibility" IS DISTINCT FROM NEW."visibility" OR OLD."shareToken" IS DISTINCT FROM NEW."shareToken")
  EXECUTE FUNCTION "map_version_bump"('access');
CREATE CONSTRAINT TRIGGER "Trip_map_changed" AFTER UPDATE OF "title", "slug", "startDate", "endDate", "timezone", "themeKey" ON "Trip" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."title" IS DISTINCT FROM NEW."title" OR OLD."slug" IS DISTINCT FROM NEW."slug" OR OLD."startDate" IS DISTINCT FROM NEW."startDate" OR OLD."endDate" IS DISTINCT FROM NEW."endDate"
    OR OLD."timezone" IS DISTINCT FROM NEW."timezone" OR OLD."themeKey" IS DISTINCT FROM NEW."themeKey")
  EXECUTE FUNCTION "map_version_bump"('content');

-- Activities: named in the legend, and a track's colour and kind.
CREATE CONSTRAINT TRIGGER "Activity_map_added" AFTER INSERT OR DELETE ON "Activity" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('content');
CREATE CONSTRAINT TRIGGER "Activity_map_changed" AFTER UPDATE OF "title", "type", "tripId", "startTime", "trackId" ON "Activity" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."title" IS DISTINCT FROM NEW."title" OR OLD."type" IS DISTINCT FROM NEW."type" OR OLD."tripId" IS DISTINCT FROM NEW."tripId" OR OLD."startTime" IS DISTINCT FROM NEW."startTime"
    OR OLD."trackId" IS DISTINCT FROM NEW."trackId")
  EXECUTE FUNCTION "map_version_bump"('content');

-- Collections: who may see them, and what is in them.
CREATE CONSTRAINT TRIGGER "Collection_map_removed" AFTER DELETE ON "Collection" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('access');
CREATE CONSTRAINT TRIGGER "Collection_map_access" AFTER UPDATE OF "visibility", "shareToken" ON "Collection" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."visibility" IS DISTINCT FROM NEW."visibility" OR OLD."shareToken" IS DISTINCT FROM NEW."shareToken")
  EXECUTE FUNCTION "map_version_bump"('access');
CREATE CONSTRAINT TRIGGER "CollectionItem_map_added" AFTER INSERT ON "CollectionItem" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('content');
CREATE CONSTRAINT TRIGGER "CollectionItem_map_removed" AFTER DELETE ON "CollectionItem" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('access');
CREATE CONSTRAINT TRIGGER "CollectionItem_map_moved" AFTER UPDATE OF "collectionId", "photoId" ON "CollectionItem" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."collectionId" IS DISTINCT FROM NEW."collectionId" OR OLD."photoId" IS DISTINCT FROM NEW."photoId")
  EXECUTE FUNCTION "map_version_bump"('access');

-- Tracks: their place on the map, name, time, trip and uploader, and their length in the list.
CREATE CONSTRAINT TRIGGER "Track_map_added" AFTER INSERT OR DELETE ON "Track" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('content');
CREATE CONSTRAINT TRIGGER "Track_map_changed" AFTER UPDATE OF "name", "tripId", "uploaderId", "source", "startTime", "minLat", "maxLat", "minLng", "maxLng" ON "Track" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."name" IS DISTINCT FROM NEW."name" OR OLD."tripId" IS DISTINCT FROM NEW."tripId" OR OLD."uploaderId" IS DISTINCT FROM NEW."uploaderId" OR OLD."source" IS DISTINCT FROM NEW."source"
    OR OLD."startTime" IS DISTINCT FROM NEW."startTime" OR OLD."minLat" IS DISTINCT FROM NEW."minLat" OR OLD."maxLat" IS DISTINCT FROM NEW."maxLat"
    OR OLD."minLng" IS DISTINCT FROM NEW."minLng" OR OLD."maxLng" IS DISTINCT FROM NEW."maxLng")
  EXECUTE FUNCTION "map_version_bump"('content');
CREATE CONSTRAINT TRIGGER "TrackStats_map_changed" AFTER INSERT OR DELETE OR UPDATE OF "distanceM" ON "TrackStats" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('content');

-- Members: the legend names them.
CREATE CONSTRAINT TRIGGER "User_map_changed" AFTER INSERT OR DELETE OR UPDATE OF "name", "email" ON "User" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "map_version_bump"('content');

-- Emptied wholesale (the end-to-end suite's reset): a statement trigger, since TRUNCATE fires no row triggers.
CREATE TRIGGER "Photo_map_truncated" AFTER TRUNCATE ON "Photo" FOR EACH STATEMENT EXECUTE FUNCTION "map_version_bump"('access');
CREATE TRIGGER "Trip_map_truncated" AFTER TRUNCATE ON "Trip" FOR EACH STATEMENT EXECUTE FUNCTION "map_version_bump"('access');
CREATE TRIGGER "Collection_map_truncated" AFTER TRUNCATE ON "Collection" FOR EACH STATEMENT EXECUTE FUNCTION "map_version_bump"('access');
CREATE TRIGGER "CollectionItem_map_truncated" AFTER TRUNCATE ON "CollectionItem" FOR EACH STATEMENT EXECUTE FUNCTION "map_version_bump"('access');
