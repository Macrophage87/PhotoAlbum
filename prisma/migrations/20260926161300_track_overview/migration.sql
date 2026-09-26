-- A short copy of each track's line for the map of every trip, so that map no longer reads (or sends) thousands of
-- points per track. New tracks work theirs out when they are saved; older ones get theirs the first time the map
-- needs it, rather than here, where working out every track at once would hold the table for the length of it.
ALTER TABLE "Track" ADD COLUMN "overview" JSONB;
