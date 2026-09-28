-- Removing a member and deleting a trip, in steps (see src/lib/auth/remove-member.ts and src/lib/trips/delete.ts).
--
-- Each rewrites every photograph it touches, milliseconds apiece, so neither fits one transaction once somebody has
-- tens of thousands. Both now mark what is going first; the photographs are then handed over or let go of a batch
-- at a time, and the account or the trip goes last. The mark is what a run interrupted half-way is finished from.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "removingAt" TIMESTAMP(3),
ADD COLUMN     "removingById" TEXT;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "deletingAt" TIMESTAMP(3);

-- Whoever takes over from a member being removed cannot be deleted before that is finished.
-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_removingById_fkey" FOREIGN KEY ("removingById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A member's uploads, found a batch at a time rather than by reading every photograph for each batch.
-- CreateIndex
CREATE INDEX "Photo_uploaderId_idx" ON "Photo"("uploaderId");
