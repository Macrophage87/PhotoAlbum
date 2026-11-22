import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

// The animal-detection side effects of the people actions (#17): what each action leaves on the detection rows.
const who = vi.hoisted(() => ({ role: "ADMIN" as "MEMBER" | "ADMIN", id: "" }));
const queued = vi.hoisted(() => [] as { name: string; data: unknown }[]);
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (name: string, data: unknown) => void queued.push({ name, data }) }));

import { confirmProposal, deletePerson, rejectProposalAction, tagPet, untagPerson } from "@/app/people/actions";

describe("pet actions and the animals the detector found", () => {
  let me: string, photo: string, other: string, biscuit: string;

  const mkPhoto = async (name: string) =>
    (await db.photo.create({ data: { uploaderId: me, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY" } })).id;
  const animal = (photoId: string, species: "DOG" | "CAT", extra: Record<string, unknown> = {}) =>
    db.animalDetection.create({ data: { photoId, species, box: [0.1, 0.5, 0.4, 0.4], confidence: 0.9, ...extra }, select: { id: true } }).then((r) => r.id);
  const row = (id: string) => db.animalDetection.findUniqueOrThrow({ where: { id }, select: { status: true, personId: true, proposedPersonId: true } });

  beforeEach(async () => {
    await resetTestDb();
    queued.length = 0;
    me = (await db.user.create({ data: { email: "x@example.com", role: "ADMIN" } })).id;
    who.id = me;
    who.role = "ADMIN";
    photo = await mkPhoto("a.jpg");
    other = await mkPhoto("b.jpg");
    biscuit = (await db.person.create({ data: { name: "Biscuit", kind: "PET", species: "DOG", createdById: me } })).id;
  });

  it("tagPet claims the photo's open dogs (not its cats, not other photos') and asks for matching again", async () => {
    const dog = await animal(photo, "DOG");
    const proposed = await animal(photo, "DOG", { status: "PROPOSED", proposedPersonId: biscuit });
    const cat = await animal(photo, "CAT");
    const elsewhere = await animal(other, "DOG");
    await tagPet(photo, biscuit);
    for (const id of [dog, proposed]) expect(await row(id)).toEqual({ status: "CONFIRMED", personId: biscuit, proposedPersonId: null });
    expect(await row(cat)).toEqual({ status: "DETECTED", personId: null, proposedPersonId: null });
    expect(await row(elsewhere)).toEqual({ status: "DETECTED", personId: null, proposedPersonId: null });
    expect(await db.face.count({ where: { photoId: photo, personId: biscuit, status: "CONFIRMED" } })).toBe(1);
    expect(queued.some((q) => q.name === "match-animals" && (q.data as { photoId: string }).photoId === other)).toBe(true);
  });

  it("untagPerson turns the pet's detections on that photo into negatives for it, and leaves other photos alone", async () => {
    const dog = await animal(photo, "DOG");
    const kept = await animal(other, "DOG", { status: "CONFIRMED", personId: biscuit });
    await tagPet(photo, biscuit);
    await untagPerson(photo, biscuit);
    expect(await row(dog)).toEqual({ status: "REJECTED", personId: null, proposedPersonId: biscuit });
    expect(await row(kept)).toEqual({ status: "CONFIRMED", personId: biscuit, proposedPersonId: null });
    expect(await db.face.count({ where: { photoId: photo, personId: biscuit } })).toBe(0);
  });

  it("deletePerson gives the pet's detections back as unclaimed animals, not rows pointing at nobody", async () => {
    const confirmed = await animal(photo, "DOG", { status: "CONFIRMED", personId: biscuit });
    const proposed = await animal(other, "DOG", { status: "PROPOSED", proposedPersonId: biscuit });
    const rejected = await animal(other, "DOG", { status: "REJECTED", proposedPersonId: biscuit });
    const rex = (await db.person.create({ data: { name: "Rex", kind: "PET", species: "DOG", createdById: me } })).id;
    const rexs = await animal(other, "DOG", { status: "CONFIRMED", personId: rex });
    await deletePerson(biscuit);
    expect(await db.person.findUnique({ where: { id: biscuit } })).toBeNull();
    for (const id of [confirmed, proposed, rejected]) expect(await row(id)).toEqual({ status: "DETECTED", personId: null, proposedPersonId: null });
    expect(await row(rexs)).toEqual({ status: "CONFIRMED", personId: rex, proposedPersonId: null });
  });

  it("deletePerson is for admins only and changes nothing for a member", async () => {
    const confirmed = await animal(photo, "DOG", { status: "CONFIRMED", personId: biscuit });
    who.role = "MEMBER";
    await expect(deletePerson(biscuit)).rejects.toThrow();
    expect(await row(confirmed)).toEqual({ status: "CONFIRMED", personId: biscuit, proposedPersonId: null });
  });

  it("confirming and rejecting an animal proposal records the answer on the detection", async () => {
    const yes = await animal(photo, "DOG", { status: "PROPOSED", proposedPersonId: biscuit });
    const no = await animal(other, "DOG", { status: "PROPOSED", proposedPersonId: biscuit });
    await confirmProposal(`animal:${yes}`);
    await rejectProposalAction(`animal:${no}`);
    expect(await row(yes)).toEqual({ status: "CONFIRMED", personId: biscuit, proposedPersonId: null });
    expect(await row(no)).toEqual({ status: "REJECTED", personId: null, proposedPersonId: biscuit });
  });

  it("confirming a pet the notes proposed also claims that photo's detected animals of its kind", async () => {
    const dog = await animal(photo, "DOG");
    const cat = await animal(photo, "CAT");
    const face = await db.face.create({ data: { photoId: photo, proposedPersonId: biscuit, status: "PROPOSED", box: [0, 0, 1, 1], confidence: 0 } });
    await confirmProposal(face.id);
    expect(await db.face.findUniqueOrThrow({ where: { id: face.id } })).toMatchObject({ status: "CONFIRMED", personId: biscuit });
    expect(await row(dog)).toEqual({ status: "CONFIRMED", personId: biscuit, proposedPersonId: null });
    expect(await row(cat)).toEqual({ status: "DETECTED", personId: null, proposedPersonId: null });
  });
});
