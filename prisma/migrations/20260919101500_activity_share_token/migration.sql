-- A secret link to one activity. Written by hand rather than generated: `migrate dev` reads this schema's
-- Unsupported() vector columns as index-less and writes DropIndex for every search and embedding index alongside
-- whatever was actually asked for.

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "shareToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Activity_shareToken_key" ON "Activity"("shareToken");
