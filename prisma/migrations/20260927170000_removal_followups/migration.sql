-- Follow-ups to removing members and deleting trips in steps (20260927150000_remove_in_steps).

-- A removed member's Google grant, kept from the transaction that deletes the account until Google has been told.
-- Before, it was revoked after that commit from memory, so a crash in between left the grant alive at Google.
-- CreateTable
CREATE TABLE "PendingRevoke" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingRevoke_pkey" PRIMARY KEY ("id")
);

-- A trip marked for deletion is made private, with its links withdrawn, in the same statement (src/lib/trips/delete.ts),
-- so visitors lose it at once, by every route that asks whether they may see it. Its photographs are leaving it a
-- batch at a time, and each batch indexes them again, so the change of visibility does not rewrite them all at once
-- here: that one statement would be exactly the long transaction the batches avoid.
CREATE OR REPLACE FUNCTION photo_search_refresh_trip_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deletingAt" IS NULL AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.visibility IS DISTINCT FROM OLD.visibility) THEN
    UPDATE "Photo" SET "updatedAt" = "updatedAt" WHERE "tripId" = NEW.id;
  END IF;
  RETURN NULL;
END $$;
