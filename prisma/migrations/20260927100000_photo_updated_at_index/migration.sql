-- The map of the album asks for the latest change to any photograph on every view (src/lib/map/cache.ts).
CREATE INDEX "Photo_updatedAt_idx" ON "Photo"("updatedAt");
