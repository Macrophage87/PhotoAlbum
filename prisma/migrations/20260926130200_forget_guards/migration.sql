-- What forgetting somebody needs to know to do it properly.
--
-- Photo.namesScrubbedAt: when a forgotten name was last taken out of the helper's text on an item, so an answer to
-- a request built before then (a batch takes hours) is thrown away instead of writing the name back.
-- Person.formerNames: a renamed person is still in text written under the old name.
-- Person.namesPendingScrub: people whose name was handed to the helper without evidence they are adults.
-- descriptionByHelper: which trip, collection and activity descriptions are the helper's words, since only those
-- are rewritten; nobody recorded it before, so every existing description counts as a member's.
ALTER TABLE "Photo" ADD COLUMN "namesScrubbedAt" TIMESTAMP(3);
ALTER TABLE "Person" ADD COLUMN "formerNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "namesPendingScrub" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Trip" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Collection" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Activity" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;

-- Somebody agreed to be named with no birthday showing an adult and no attestation: that agreement could have been
-- given for a child, so it is withdrawn, and what the helper already wrote with their name is scrubbed by the
-- nightly people job.
UPDATE "Person" SET "namesPendingScrub" = true, "nameInDescriptions" = false
WHERE kind = 'HUMAN' AND "nameInDescriptions"
  AND NOT (birthday <= (now() - interval '18 years') OR (birthday IS NULL AND "adultAttestedAt" IS NOT NULL));
