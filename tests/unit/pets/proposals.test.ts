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

/** A unit vector at cosine `c` from `a`, leaning towards `b` (both unit vectors, roughly orthogonal). */
const near = (a: number[], b: number[], c: number) => {
  const d = a.reduce((x, v, i) => x + v * b[i], 0);
  const perp = b.map((v, i) => v - d * a[i]);
  const pn = Math.sqrt(perp.reduce((x, v) => x + v * v, 0));
  return a.map((v, i) => c * v + Math.sqrt(1 - c * c) * (perp[i] / pn));
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
  async function animal(photoId: string, species: "DOG" | "CAT" | "BIRD", vec: number[]) {
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
    expect(await proposeAnimalsForPhoto(photoB)).toBe(1);
    await rejectAnimal(bId);
    expect((await db.animalDetection.findUniqueOrThrow({ where: { id: bId } })).status).toBe("REJECTED");
    // A second dog on the same photo, just like Biscuit: the "no" there must stop Biscuit being proposed for it.
    const b2 = await animal(photoB, "DOG", unit(1));
    expect(await proposeAnimalsForPhoto(photoB)).toBe(0);
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: b2 } })).toMatchObject({ status: "DETECTED", proposedPersonId: null });
    await releaseAnimalsForPet(photoA, biscuit);
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ status: "REJECTED", personId: null, proposedPersonId: biscuit });
  });
  it("a rejected crop counts against the pet on other photos too (#22)", async () => {
    const photoC = (await db.photo.create({ data: { uploaderId: userId, originalName: "c.jpg", mimeType: "image/jpeg", storageKey: "c.jpg", originalPath: "c.jpg/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date("2021-06-01") } })).id;
    await animal(photoA, "DOG", unit(1));
    await claimAnimalsForPet(photoA, biscuit);
    // The neighbour's dog: close enough to Biscuit to be proposed, and a member says no.
    const look = near(unit(1), unit(4), 0.9);
    const bId = await animal(photoB, "DOG", look);
    expect(await proposeAnimalsForPhoto(photoB)).toBe(1);
    await rejectAnimal(bId);
    // The same dog again on another photo is not proposed as Biscuit; Biscuit himself still is.
    const cNeighbour = await animal(photoC, "DOG", look);
    const cBiscuit = await animal(photoC, "DOG", unit(1));
    expect(await proposeAnimalsForPhoto(photoC)).toBe(1);
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: cNeighbour } })).toMatchObject({ status: "DETECTED", proposedPersonId: null });
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: cBiscuit } })).toMatchObject({ status: "PROPOSED", proposedPersonId: biscuit });
  });
  it("a bird is proposed as the chickens only when the photo's description mentions them (#23)", async () => {
    const chickens = (await db.person.create({ data: { kind: "PET", name: "The chickens", species: "CHICKEN", isFlock: true, createdById: userId } })).id;
    const gull = await animal(photoA, "BIRD", unit(6));
    const hen = await animal(photoB, "BIRD", unit(7));
    await db.photo.update({ where: { id: photoA }, data: { annotation: { caption: "A seagull on the pier", description: "A gull watches the waves.", tags: ["beach", "seagull"] } } });
    await db.photo.update({ where: { id: photoB }, data: { annotation: { caption: "Feeding time", description: "Grandpa scatters corn for the hens.", tags: ["farm"] } } });
    expect(await proposeAnimalsForPhoto(photoA)).toBe(0);
    expect(await proposeAnimalsForPhoto(photoB)).toBe(1);
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: gull } })).toMatchObject({ status: "DETECTED" });
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: hen } })).toMatchObject({ status: "PROPOSED", proposedPersonId: chickens });
    // Tagging the chickens by hand on a photo claims its birds, which is what teaches the matcher their look.
    const another = await animal(photoA, "BIRD", unit(8));
    expect(await claimAnimalsForPet(photoA, chickens)).toBe(2);
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: another } })).toMatchObject({ status: "CONFIRMED", personId: chickens });
  });
  it("a pet's Looks like words in the description suggest it among several of its kind (#11)", async () => {
    const rex = (await db.person.create({ data: { kind: "PET", name: "Rex", species: "DOG", descriptors: "black lab", createdById: userId } })).id;
    await db.person.update({ where: { id: biscuit }, data: { descriptors: "golden retriever" } });
    const dogB = await animal(photoB, "DOG", unit(3));
    expect(await proposeAnimalsForPhoto(photoB)).toBe(0);
    await db.photo.update({ where: { id: photoB }, data: { annotation: { caption: "Nap time", description: "A black lab asleep by the fire.", tags: ["dog"] } } });
    expect(await proposeAnimalsForPhoto(photoB)).toBe(1);
    expect(await db.animalDetection.findUniqueOrThrow({ where: { id: dogB } })).toMatchObject({ status: "PROPOSED", proposedPersonId: rex });
  });
  it("respects the pet's years with the family", async () => {
    await animal(photoA, "DOG", unit(1));
    await claimAnimalsForPet(photoA, biscuit);
    await db.person.update({ where: { id: biscuit }, data: { livedTo: new Date("2019-01-01") } });
    await animal(photoB, "DOG", unit(1));
    expect(await proposeAnimalsForPhoto(photoB)).toBe(0);
  });
});
