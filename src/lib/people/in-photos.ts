import { db } from "@/lib/db";
import type { PersonKind } from "@/generated/prisma/enums";
import { NOT_TRASHED } from "@/lib/photos/trash";

export type FilterPerson = { id: string; name: string; kind: PersonKind };

/**
 * Who a search can ask for: the people and pets who are actually on something here.
 *
 * Somebody is on a photograph either because a member said so — a tag, or a confirmed name on a face the detector
 * found — or, for a pet, because the animal matcher's guess was confirmed. Both are gathered, because "photographs
 * with Biscuit in them" means the same thing to a family however the album came to know it was Biscuit.
 *
 * The list is narrowed to the trip or collection being looked at, so the picker offers who can be found here rather
 * than everybody the album has ever heard of. Anyone who asked to be forgotten is never offered.
 */
export async function peopleInPhotos(scope: { tripId?: string; collectionId?: string } = {}): Promise<FilterPerson[]> {
  const within = scope.tripId
    ? { tripId: scope.tripId }
    : scope.collectionId
      ? { collections: { some: { collectionId: scope.collectionId } } }
      : {};
  const on = { ...within, ...NOT_TRASHED, status: "READY" as const };
  return db.person.findMany({
    where: {
      optedOutAt: null,
      OR: [{ faces: { some: { status: "CONFIRMED", photo: on } } }, { animals: { some: { status: "CONFIRMED", photo: on } } }],
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    select: { id: true, name: true, kind: true },
  });
}

/**
 * Which photographs somebody is on, as a list of ids.
 *
 * Answered the same way words and years are, so it composes with them: everything in every list, and nothing else.
 */
export async function idsWithPerson(personId: string): Promise<string[]> {
  const [faces, animals] = await Promise.all([
    db.face.findMany({ where: { personId, status: "CONFIRMED" }, select: { photoId: true } }),
    db.animalDetection.findMany({ where: { personId, status: "CONFIRMED" }, select: { photoId: true } }),
  ]);
  return [...new Set([...faces, ...animals].map((r) => r.photoId))];
}
