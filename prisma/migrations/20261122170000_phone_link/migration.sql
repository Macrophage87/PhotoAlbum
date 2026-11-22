-- A member's say-so, given on the website, that a phone may be connected as them: the hash of a one-time code.
CREATE TABLE "PhoneLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneLink_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PhoneLink_userId_idx" ON "PhoneLink"("userId");

ALTER TABLE "PhoneLink" ADD CONSTRAINT "PhoneLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
