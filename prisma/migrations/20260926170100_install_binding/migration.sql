-- Which database the install id was given to (the cluster's system identifier and the database's name), so a copy
-- of this database, which carries the same id, is not taken for it.
ALTER TABLE "AppSetting" ADD COLUMN "installBinding" TEXT;
