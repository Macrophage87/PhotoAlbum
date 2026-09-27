-- How names are checked before words are shown to everyone: strict (as before, and the default) or relaxed, for the
-- album and, overriding it, for a trip (src/lib/people/name-check.ts).
CREATE TYPE "NameCheck" AS ENUM ('STRICT', 'RELAXED');

ALTER TABLE "AppSetting"
  ADD COLUMN "nameCheck" "NameCheck" NOT NULL DEFAULT 'STRICT',
  ADD COLUMN "nameCheckSetAt" TIMESTAMP(3),
  ADD COLUMN "nameCheckSetById" TEXT,
  ADD COLUMN "nameCheckTightenedAt" TIMESTAMP(3),
  ADD COLUMN "nameCheckRecheckedAt" TIMESTAMP(3);

ALTER TABLE "Trip"
  ADD COLUMN "nameCheck" "NameCheck",
  ADD COLUMN "nameCheckSetAt" TIMESTAMP(3),
  ADD COLUMN "nameCheckSetById" TEXT;
