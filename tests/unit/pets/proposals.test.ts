import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { vectorLiteral } from "@/lib/ml/client";
import { claimAnimalsForPet, confirmAnimalAs, proposeAnimalsForPhoto, rejectAnimal, releaseAnimalsForPet } from "@/lib/pets/proposals";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

const unit = (seed: number) => {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(seed * 7 + i * 1.3));
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
};

describe("animal proposals", () => {
  let userId: string, biscuit: string, photoA: string, photoB: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "p@example.com", role: "ADMIN" } })).id;
    biscuit = (await db.person.create({ data: { kind: "PET", name: "Biscuit", species: "DOG", createdById: userId } })).id;
    const mk = (name: string) => db.photo.create({ data: { uploaderId: userId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", takenAt: new Date("2021-06-01") } });
    photoA = (await mk("a.jpg")).id;
    photoB = (await mk("b.jpg")).id;
  });
  async function animal(photoId: string, species: "DOG" | "CAT", vec: number[]) {
    const a = await db.animalDetection.create({ data: { photoId, species, box: [0.1, 0.5, 0.4, 0.4], confidence: 0.9 }, select: { id: true } });
    await db.$executeRaw`UPDATE "AnimalDetection" SET embedding = ${vectorLiteral(vec)}::vector WHERE id = ${a.id}`;
    return a.id;
  }
  it("a hand tag claims the photo's dogs, after which a look-alike elsewhere is proposed and can be confirmed", async () => {
    await animal(photoA, "DOG", unit(1));
    const bId = await animal(photoB, "DOG", unit(1));
    await animal(photoB, "CAT", unit(1));
    expect(await proposeAnimalsForPhoto(photoB)).toBe(0);
    expect(await claimAnimalsForPet(photoA, biscuit)).toBe(1);
    expect(await proposeAnimalsForPhoto(photoB)).toBe(1);
    const proposed = await db.animalDetection.findUniqueOrThrow({ where: { id: bId } });
    expect(proposed).toMatchObject({ status: "PROPOSED", proposedPersonId: biscuit });
    expect(await db.animalDetection.count({ where: { photoId: photoB, species: "CAT", status: "DETECTED" } })).toBe(1);
    await confirmAnimalAs(bId, biscuit);
    const face = await db.face.findFirstOrThrow({ where: { photoId: photoB, personId: biscuit, status: "CONFIRMED" } });
    expect(face.box).toEqual([0.1, 0.5, 0.4, 0.4]);
    expect(face.confidence).toBe(0);
    const search = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Photo" WHERE "searchVectorMembers" @@ websearch_to_tsquery('simple', 'Biscuit')`;
    // Both sightings are confirmed now (the hand tag on A, the proposal on B), so both are found by name.
    expect(search.map((r) => r.id).sort()).toEqual([photoA, photoB].sort());
  });
  it("a rejection is remembered for that photo, and untagging releases the claim as a negative", async () => {
    const aId = await animal(photoA, "DOG", unit(1));
    await claimAnimalsForPet(photoA, biscuit);
    const bId = await animal(photoB, "DOG", unit(1));
    await proposeAnimalsForPhoto(photoB);
    await rejectAnimal(bId);
    expect((await db.animalDetection.findUniqueOrThrow({ where: { id: bId } })).status).toBe("REJECTED");
    expect(await proposeAnimalsForPhoto(photoB)).toBe(0);
    await releaseAnimalsForPet(photoA, biscuit);
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ status: "REJECTED", personId: null, proposedPersonId: biscuit });
  });
  it("respects the pet's years with the family", async () => {
    await animal(photoA, "DOG", unit(1));
    await claimAnimalsForPet(photoA, biscuit);
    await db.person.update({ where: { id: biscuit }, data: { livedTo: new Date("2019-01-01") } });
    await animal(photoB, "DOG", unit(1));
    expect(await proposeAnimalsForPhoto(photoB)).toBe(0);
  });
});
