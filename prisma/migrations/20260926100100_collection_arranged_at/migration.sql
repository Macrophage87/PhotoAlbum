-- When somebody last put a collection's items in an order of their own. Null: nobody has, and the items sit in the
-- order they were added.
ALTER TABLE "Collection" ADD COLUMN "arrangedAt" TIMESTAMP(3);

-- Collections already arranged by hand or by date, recognised by their saved order differing from the order the
-- items were added in. Items added in one go share a moment, and are told apart by id: ids are made in the order the
-- rows are, so within one moment they ascend as the positions given them did (compared byte by byte, "C").
-- Folding duplicates can place a kept photograph at a copy's position, so a collection that was folded into and
-- never arranged may be counted as arranged; it then opens in the order it was already in, which is harmless.
UPDATE "Collection" c SET "arrangedAt" = c."updatedAt"
WHERE EXISTS (
  SELECT 1 FROM (
    SELECT row_number() OVER (ORDER BY i.position, i."createdAt", i.id COLLATE "C") AS saved,
           row_number() OVER (ORDER BY i."createdAt", i.id COLLATE "C") AS added
    FROM "CollectionItem" i WHERE i."collectionId" = c.id
  ) o WHERE o.saved <> o.added
);
