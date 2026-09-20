-- Who was on a trip and who was on an outing.
--
-- Written by hand rather than generated: `prisma migrate dev` cannot run non-interactively here, and it rewrites
-- the vector columns it does not understand. The shape is Prisma's own for an implicit many-to-many — table named
-- after the relation, columns "A" and "B" in the models' alphabetical order, both cascading.
--
-- No backfill: an empty list means everybody, so every trip and activity that already exists keeps behaving
-- exactly as it did.
CREATE TABLE "_TripParticipants" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_TripParticipants_AB_pkey" PRIMARY KEY ("A", "B")
);
CREATE INDEX "_TripParticipants_B_index" ON "_TripParticipants"("B");
ALTER TABLE "_TripParticipants" ADD CONSTRAINT "_TripParticipants_A_fkey" FOREIGN KEY ("A") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_TripParticipants" ADD CONSTRAINT "_TripParticipants_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "_ActivityParticipants" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_ActivityParticipants_AB_pkey" PRIMARY KEY ("A", "B")
);
CREATE INDEX "_ActivityParticipants_B_index" ON "_ActivityParticipants"("B");
ALTER TABLE "_ActivityParticipants" ADD CONSTRAINT "_ActivityParticipants_A_fkey" FOREIGN KEY ("A") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ActivityParticipants" ADD CONSTRAINT "_ActivityParticipants_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
