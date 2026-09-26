-- "No activity, with who chose it" now means a member took the photograph off its activities by hand, and the
-- clock leaves it loose. Before, that combination only ever arose by accident: an activity deleted from under a
-- photograph filed on it by hand, "No activity" in the trip gallery's bulk bar, or a move to another trip that
-- kept the old setter. None of those was anybody saying "not on any activity", so the setter is forgotten and
-- those photographs go back to being filed by their time.
UPDATE "Photo" SET "activitySetById" = NULL WHERE "activityId" IS NULL AND "activitySetById" IS NOT NULL;
