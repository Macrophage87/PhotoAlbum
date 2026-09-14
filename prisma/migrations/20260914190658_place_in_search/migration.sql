-- The place written on a photograph becomes searchable.
--
-- A member who pins a photograph to a spot on the map gets a name for it — "Bass Harbor Head Light" — and that is
-- often the first thing anyone would type when looking for the picture again. It was the one thing about a
-- photograph that the search could not see: captions, titles, notes, the helper's description and its guess at a
-- place were all indexed, but the place a person actually chose was not.
--
-- Hand-written rather than generated: nothing about the schema changes, only the function the trigger already calls,
-- so there is no table to alter and no index to rebuild.
CREATE OR REPLACE FUNCTION photo_search_base(p "Photo") RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('english', coalesce(p.caption, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.title, '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'caption', '')), 'A')
      || setweight(to_tsvector('english', coalesce(p.context, '')), 'B')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'description', '')), 'B')
      || setweight(to_tsvector('english', coalesce(p."placeName", '')), 'B')
      || setweight(to_tsvector('simple', coalesce(p."placeName", '')), 'B')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'place', '')), 'B')
      || setweight(to_tsvector('english', coalesce((SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.annotation->'tags') = 'array' THEN p.annotation->'tags' ELSE '[]'::jsonb END) t), '')), 'B')
      || setweight(to_tsvector('english', coalesce(p.annotation->>'searchSummary', '')), 'C')
      || setweight(to_tsvector('english', coalesce((SELECT t.title FROM "Trip" t WHERE t.id = p."tripId"), '')), 'C')
      || setweight(to_tsvector('english', coalesce((SELECT string_agg(c.title, ' ') FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" WHERE ci."photoId" = p.id), '')), 'C');
$$;

-- A no-op update re-runs the BEFORE trigger, so every photograph already in the album is re-indexed with its place.
UPDATE "Photo" SET "updatedAt" = "updatedAt";
