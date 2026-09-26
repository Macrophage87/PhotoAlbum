-- When somebody last put a collection's items in an order of their own. Null: nobody has, and the items sit in the
-- order they were added.
ALTER TABLE "Collection" ADD COLUMN "arrangedAt" TIMESTAMP(3);

-- Collections already arranged by hand or by date, recognised by an item placed ahead of one added before it. Items
-- added together share a moment, so only a strictly earlier addition placed later counts.
UPDATE "Collection" c SET "arrangedAt" = c."updatedAt"
WHERE EXISTS (
  SELECT 1 FROM (
    SELECT i."createdAt",
           max(i."createdAt") OVER (ORDER BY i.position, i."createdAt", i.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS "latestAhead"
    FROM "CollectionItem" i WHERE i."collectionId" = c.id
  ) o WHERE o."latestAhead" > o."createdAt"
);
