-- AlterEnum
ALTER TYPE "FaceStatus" ADD VALUE 'NOT_A_FACE';

-- Prisma cannot see indexes on Unsupported() columns and asks to drop them in every migration it writes; those
-- DropIndex lines were removed by hand, as the review_fixes migration explains, and a unit test checks they survive.
