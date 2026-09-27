-- This install's identity, matched against a marker file at the storage root before anything there is swept, and
-- what the hourly check last found in photos/ with no row.
ALTER TABLE "AppSetting" ADD COLUMN "installId" TEXT;
ALTER TABLE "AppSetting" ADD COLUMN "orphanFolderCount" INTEGER;
ALTER TABLE "AppSetting" ADD COLUMN "orphanFolderSample" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AppSetting" ADD COLUMN "orphanFoldersCheckedAt" TIMESTAMP(3);
