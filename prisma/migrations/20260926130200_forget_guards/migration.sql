-- What forgetting somebody needs to know to do it properly.
--
-- Photo.namesScrubbedAt: when a forgotten name was last taken out of the helper's text on an item, so an answer to
-- a request built before then (a batch takes hours) is thrown away instead of writing the name back.
-- Person.formerNames: a renamed person is still in text written under the old name.
-- Person.namingWithdrawnAt, Person.namesChangedAt, Person.adultConfirmedAt: see below.
-- descriptionByHelper: which trip, collection and activity descriptions are the helper's words; nobody recorded it
-- before, so every existing description counts as a member's.
-- AppSetting.lastForgetAt: when anybody was last forgotten; an answer to a request built before then is not stored.
-- AppSetting.forgetFinishedAt: while a forget is under way no answer is stored at all.
-- AppSetting.forgetKey / forgetKeyFingerprint: the fallback key outside production, and which key names are hashed
-- under (FORGET_HASH_KEY, never stored here, in production).
-- ForgottenName: keyed hashes of a forgotten person's names — never the names — so a name nobody may use any more
-- is recognised in an answer, or in a member's words sent to the helper, after the person's record is gone.
-- ForgetLeftover: after a forget, the places whose words still mention the name (ids and fields only), kept until an
-- admin has seen to them.
ALTER TABLE "Photo" ADD COLUMN "namesScrubbedAt" TIMESTAMP(3);
ALTER TABLE "Person" ADD COLUMN "formerNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "namingWithdrawnAt" TIMESTAMP(3),
  ADD COLUMN "namesChangedAt" TIMESTAMP(3),
  ADD COLUMN "adultConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "adultConfirmedById" TEXT,
  ADD COLUMN "namingPublicScrubbedAt" TIMESTAMP(3);
ALTER TABLE "AppSetting" ADD COLUMN "lastForgetAt" TIMESTAMP(3),
  ADD COLUMN "forgetFinishedAt" TIMESTAMP(3),
  ADD COLUMN "forgetKey" TEXT,
  ADD COLUMN "forgetKeyFingerprint" TEXT;
ALTER TABLE "Trip" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Collection" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Activity" ADD COLUMN "descriptionByHelper" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ForgottenName" (
  "hash" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "capitalizedOnly" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ForgottenName_pkey" PRIMARY KEY ("hash")
);

CREATE TABLE "ForgetLeftover" (
  "id" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "items" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dismissedAt" TIMESTAMP(3),
  "dismissedById" TEXT,
  CONSTRAINT "ForgetLeftover_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ForgetLeftover_dismissedAt_idx" ON "ForgetLeftover"("dismissedAt");

-- Only what decides whether, or as what, somebody may be named: a relationship edit or the nightly "needs a
-- decision" flag must not throw away the helper's answers about them.
CREATE OR REPLACE FUNCTION person_names_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW."formerNames" IS DISTINCT FROM OLD."formerNames"
     OR NEW."optedOutAt" IS DISTINCT FROM OLD."optedOutAt" OR NEW."nameInDescriptions" IS DISTINCT FROM OLD."nameInDescriptions"
     OR NEW."faceIndexing" IS DISTINCT FROM OLD."faceIndexing" OR NEW.birthday IS DISTINCT FROM OLD.birthday
     OR NEW."adultAttestedAt" IS DISTINCT FROM OLD."adultAttestedAt" OR NEW."adultConfirmedAt" IS DISTINCT FROM OLD."adultConfirmedAt" THEN
    NEW."namesChangedAt" := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS person_names_changed_trigger ON "Person";
CREATE TRIGGER person_names_changed_trigger BEFORE UPDATE ON "Person"
  FOR EACH ROW EXECUTE FUNCTION person_names_changed();

-- Naming somebody needs evidence they are an adult: a birthday showing 18 or older, or an admin's confirmation.
-- Anybody whose naming was agreed without it could be a child, so the agreement is switched off at once and nothing
-- more is sent. What the helper already wrote with their names waits (see Person.namingWithdrawnAt): admins are
-- shown who, and why. People whose naming was turned off before turning it off scrubbed anything are listed too.
-- Recognition alone never put a name in anything without that evidence, so it does not bring anybody in. A person
-- with no birthday and no confirmation is never "an adult" (NULL is not true), which is the case this exists for.
CREATE OR REPLACE FUNCTION withdraw_unevidenced_naming() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE "Person" SET "namingWithdrawnAt" = now()
  WHERE kind = 'HUMAN' AND "optedOutAt" IS NULL AND "namingWithdrawnAt" IS NULL
    AND ("nameInDescriptions" OR "nameInDescriptionsSetAt" IS NOT NULL)
    AND NOT COALESCE("nameInDescriptions"
      AND (birthday <= (now() - interval '18 years') OR (birthday IS NULL AND "adultAttestedAt" IS NOT NULL)), false);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE "Person" SET "nameInDescriptions" = false
  WHERE kind = 'HUMAN' AND "nameInDescriptions"
    AND NOT COALESCE(birthday <= (now() - interval '18 years') OR (birthday IS NULL AND "adultAttestedAt" IS NOT NULL), false);
  RETURN n;
END $$;
SELECT withdraw_unevidenced_naming();
DROP FUNCTION withdraw_unevidenced_naming();
