





-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "nameInDescriptions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nameInDescriptionsSetAt" TIMESTAMP(3),
ADD COLUMN     "nameInDescriptionsSetById" TEXT;
