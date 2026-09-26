-- A short copy of each track's line for the map of every trip, so that map no longer reads (or sends) thousands of
-- points per track. New tracks work theirs out when they are saved; existing ones take evenly spaced points of the
-- stored line here, both ends kept. Anything left null is thinned when the map is built.
ALTER TABLE "Track" ADD COLUMN "overview" JSONB;

UPDATE "Track" t
SET "overview" = CASE
  WHEN jsonb_array_length(t."simplified") <= 300 THEN t."simplified"
  ELSE (
    SELECT jsonb_agg(x.e ORDER BY x.i)
    FROM jsonb_array_elements(t."simplified") WITH ORDINALITY AS x(e, i)
    WHERE x.i - 1 IN (SELECT round(k * (jsonb_array_length(t."simplified") - 1)::float8 / 299)::int FROM generate_series(0, 299) AS k)
  )
END
WHERE jsonb_typeof(t."simplified") = 'array';
