-- Larger text and stronger contrast, chosen by a member for every page they read.
ALTER TABLE "User" ADD COLUMN "largeText" BOOLEAN NOT NULL DEFAULT false;
