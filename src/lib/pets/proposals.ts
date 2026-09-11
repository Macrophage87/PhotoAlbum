import { db } from "@/lib/db";
import { vectorLiteral } from "@/lib/ml/client";
import { centroidOf, matchAnimal, type PetCandidate } from "./matching";

/** Each pet with the centroid of its confirmed crops (null until a member has tagged it on a detected animal). */
export async function petCandidates(): Promise<PetCandidate[]> {
  const pets = await db.person.findMany({ where: { kind: "PET" }, select: { id: true, species: true, isFlock: true, livedFrom: true, livedTo: true } });
  const rows = await db.$queryRaw<{ personId: string; embedding: string }[]>`SELECT "personId", embedding::text AS embedding FROM "AnimalDetection" WHERE status = 'CONFIRMED' AND "personId" IS NOT NULL AND embedding IS NOT NULL`;
  const byPet = new Map<string, number[][]>();
  for (const r of rows) byPet.set(r.personId, [...(byPet.get(r.personId) ?? []), JSON.parse(r.embedding) as number[]]);
  return pets.map((p) => ({ ...p, centroid: centroidOf(byPet.get(p.id) ?? []) }));
}

/** Turn a photo's open animal detections into "Probably Biscuit?" proposals where a pet matches. */
export async function proposeAnimalsForPhoto(photoId: string): Promise<number> {
  const photo = await db.photo.findUnique({ where: { id: photoId }, select: { takenAt: true, takenAtSource: true, estimatedDate: true } });
  if (!photo) return 0;
  const when = photo.takenAt && photo.takenAtSource !== "FILE_MTIME" && photo.takenAtSource !== "UPLOAD_TIME" ? photo.takenAt : photo.estimatedDate;
  const open = await db.$queryRaw<{ id: string; species: string; embedding: string | null }[]>`SELECT id, species::text AS species, embedding::text AS embedding FROM "AnimalDetection" WHERE "photoId" = ${photoId} AND status IN ('DETECTED', 'PROPOSED')`;
  if (!open.length) return 0;
  const rejected = await db.animalDetection.findMany({ where: { photoId, status: "REJECTED", proposedPersonId: { not: null } }, select: { proposedPersonId: true } });
  const rejectedPetIds = rejected.map((r) => r.proposedPersonId!);
  const pets = await petCandidates();
  let n = 0;
  for (const a of open) {
    const hit = matchAnimal({ species: a.species, embedding: a.embedding ? (JSON.parse(a.embedding) as number[]) : null, takenAt: when, rejectedPetIds }, pets);
    if (hit) {
      const r = await db.animalDetection.updateMany({ where: { id: a.id, status: { in: ["DETECTED", "PROPOSED"] } }, data: { status: "PROPOSED", proposedPersonId: hit.petId } });
      n += r.count;
    } else await db.animalDetection.updateMany({ where: { id: a.id, status: "PROPOSED" }, data: { status: "DETECTED", proposedPersonId: null } });
  }
  return n;
}

/**
 * Attach a detected animal to a pet. Besides the detection row (which seeds future matching), a hand-tag Face row is
 * written when the photo has none for that pet, so the person page, lightbox chips, search and the AI helper's name
 * list all work through the one appearance table they already read.
 */
export async function confirmAnimalAs(animalId: string, personId: string): Promise<void> {
  const a = await db.animalDetection.findUniqueOrThrow({ where: { id: animalId }, select: { photoId: true, box: true } });
  await db.animalDetection.update({ where: { id: animalId }, data: { personId, proposedPersonId: null, status: "CONFIRMED" } });
  const existing = await db.face.findFirst({ where: { photoId: a.photoId, personId, status: "CONFIRMED" }, select: { id: true, box: true } });
  if (!existing) await db.face.create({ data: { photoId: a.photoId, personId, status: "CONFIRMED", box: a.box as number[], confidence: 0 } });
  else if ((existing.box as number[])[2] === 1) await db.face.update({ where: { id: existing.id }, data: { box: a.box as number[] } });
}

export async function rejectAnimal(animalId: string): Promise<void> {
  await db.animalDetection.updateMany({ where: { id: animalId, status: "PROPOSED" }, data: { status: "REJECTED" } });
}

/** A hand tag of a pet also claims that photo's open detections of the same species, which is what seeds matching. */
export async function claimAnimalsForPet(photoId: string, personId: string): Promise<number> {
  const pet = await db.person.findUnique({ where: { id: personId }, select: { species: true } });
  if (!pet?.species) return 0;
  const r = await db.animalDetection.updateMany({ where: { photoId, species: pet.species, status: { in: ["DETECTED", "PROPOSED"] } }, data: { personId, proposedPersonId: null, status: "CONFIRMED" } });
  return r.count;
}

/** Untagging a pet turns its detections on that photo into negatives, so the same pet is not proposed there again. */
export async function releaseAnimalsForPet(photoId: string, personId: string): Promise<void> {
  await db.animalDetection.updateMany({ where: { photoId, personId }, data: { personId: null, proposedPersonId: personId, status: "REJECTED" } });
}

export async function setAnimalEmbedding(animalId: string, embedding: number[]): Promise<void> {
  await db.$executeRaw`UPDATE "AnimalDetection" SET embedding = ${vectorLiteral(embedding)}::vector WHERE id = ${animalId}`;
}
