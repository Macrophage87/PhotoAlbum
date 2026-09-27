-- When a forget made its leftover list, so a forget cut short before it did gets one when it is finished, and one
-- that did never gets a second.
ALTER TABLE "Person" ADD COLUMN "forgetListedAt" TIMESTAMP(3);
