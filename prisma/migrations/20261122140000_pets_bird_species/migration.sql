-- The detector's COCO "bird" class is any bird, not a chicken (#23). Added on its own: a new enum value cannot be
-- used in the same transaction that adds it.
ALTER TYPE "Species" ADD VALUE IF NOT EXISTS 'BIRD' AFTER 'CHICKEN';
