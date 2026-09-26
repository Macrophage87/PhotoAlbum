import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "ADMIN" as "MEMBER" | "ADMIN", id: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { optOutPerson, updatePerson, updatePet } from "@/app/people/actions";

const annotation: StoredAnnotation = {
  title: "Ada at the lake",
  caption: "Ada wading in at the lake",
  description: "Ada and Ben spend the afternoon at the lake. Ada's dog swims out to the raft.",
  tags: ["lake", "ada", "ada's dog", "adapter"],
  place: "Ada's cabin",
  activity: "swimming",
  objects: ["raft", "ada's hat"],
  visibleText: null,
  season: "summer",
  mood: "happy",
  searchSummary: "ada lake swim summer ben",
};

const form = (mode?: string) => {
  const fd = new FormData();
  if (mode) fd.set("mode", mode);
  return fd;
};

describe("forgetting somebody", () => {
  let admin: string, member: string, photoId: string, adaId: string, tripId: string, activityId: string, collectionId: string, otherTripId: string;

  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    member = (await db.user.create({ data: { email: "member@example.com", role: "MEMBER" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    tripId = (await db.trip.create({ data: { slug: "lake", title: "The lake", description: "A week at the lake. Ada swam every morning.", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-07"), createdById: admin } })).id;
    otherTripId = (await db.trip.create({ data: { slug: "elsewhere", title: "Elsewhere", description: "Ada came too.", startDate: new Date("2026-08-01"), endDate: new Date("2026-08-02"), createdById: admin } })).id;
    activityId = (await db.activity.create({ data: { tripId, title: "Swim", startTime: new Date("2026-07-02T09:00:00Z"), endTime: new Date("2026-07-02T10:00:00Z"), description: "Ada and Ben swam to the raft." } })).id;
    collectionId = (await db.collection.create({ data: { slug: "summer", title: "Summer", description: "Summer with Ada, in Canada.", createdById: admin } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: admin, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY", tripId, activityId, title: "Ada at the lake", caption: "Our day out", annotation, annotatedAt: new Date(), estimatedDateNote: "1990–1995: Ada looks about ten" } })).id;
    await db.collectionItem.create({ data: { collectionId, photoId, addedById: admin } });
    await db.mediaAnnotationRaw.create({ data: { photoId, model: "m", response: { text: "Ada at the lake" } } });
    adaId = (await db.person.create({ data: { name: "Ada", birthday: new Date("1950-01-01"), faceIndexing: true, nameInDescriptions: true, createdById: admin } })).id;
    await db.face.create({ data: { photoId, personId: adaId, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0.9 } });
  });

  const found = async (column: "searchVector" | "searchVectorMembers", word: string) =>
    (await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "Photo" WHERE "${column}" @@ plainto_tsquery('simple', $1)`, word)).map((r) => r.id);

  it("takes the name out of the title, the helper's record and the descriptions written from it", async () => {
    // The title the helper copied onto the item is what made her findable after she was forgotten.
    expect(await found("searchVector", "ada")).toEqual([photoId]);
    await optOutPerson(adaId, form());

    const photo = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(photo.title).toBe("A family member at the lake");
    const a = photo.annotation as StoredAnnotation;
    expect(a.title).toBe("A family member at the lake");
    expect(a.description).toBe("A family member and Ben spend the afternoon at the lake. A family member's dog swims out to the raft.");
    // Tags that name her go; tags that merely contain the letters stay.
    expect(a.tags).toEqual(["lake", "adapter"]);
    expect(a.objects).toEqual(["raft"]);
    expect(photo.estimatedDateNote).toBe("1990–1995: a family member looks about ten");
    // The member's own caption is theirs, and had nothing to take out anyway.
    expect(photo.caption).toBe("Our day out");

    // Trips, activities and collections the photograph belongs to were described from her name.
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).description).toBe("A week at the lake. A family member swam every morning.");
    expect((await db.activity.findUniqueOrThrow({ where: { id: activityId } })).description).toBe("A family member and Ben swam to the raft.");
    expect((await db.collection.findUniqueOrThrow({ where: { id: collectionId } })).description).toBe("Summer with a family member, in Canada.");
    // A trip she was never photographed on is somebody's own words, and not this run's business.
    expect((await db.trip.findUniqueOrThrow({ where: { id: otherTripId } })).description).toBe("Ada came too.");

    expect(await found("searchVector", "ada")).toEqual([]);
    expect(await found("searchVectorMembers", "ada")).toEqual([]);
    expect(await db.mediaAnnotationRaw.count({ where: { photoId } })).toBe(0);
    expect(await db.person.findUnique({ where: { id: adaId } })).toBeNull();
  });

  it("scrubs the same way when they keep their name on the photographs", async () => {
    await optOutPerson(adaId, form("keep-name"));
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).title).toBe("A family member at the lake");
    const ada = await db.person.findUniqueOrThrow({ where: { id: adaId } });
    expect(ada.optedOutAt).not.toBeNull();
    // The confirmed appearance stays as a plain record, but her name is out of the members' index.
    expect(await db.face.count({ where: { personId: adaId, status: "CONFIRMED" } })).toBe(1);
    expect(await found("searchVectorMembers", "ada")).toEqual([]);
  });

  it("is only for whoever added the person, and admins", async () => {
    who.role = "MEMBER";
    who.id = member;
    await expect(optOutPerson(adaId, form())).rejects.toThrow(/added them/);
    await expect(optOutPerson(adaId, form("keep-name"))).rejects.toThrow(/added them/);
    const rename = new FormData();
    rename.set("name", "Somebody else");
    await expect(updatePerson(adaId, rename)).rejects.toThrow(/added them/);
    // Nothing happened: her tags, her record and the text are all as they were.
    expect(await db.face.count({ where: { personId: adaId } })).toBe(1);
    expect((await db.person.findUniqueOrThrow({ where: { id: adaId } })).name).toBe("Ada");
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).title).toBe("Ada at the lake");

    // The member who added somebody may rename and forget them.
    const theirs = await db.person.create({ data: { name: "Cousin Al", createdById: member } });
    await updatePerson(theirs.id, rename);
    expect((await db.person.findUniqueOrThrow({ where: { id: theirs.id } })).name).toBe("Somebody else");
    await optOutPerson(theirs.id, form());
    expect(await db.person.findUnique({ where: { id: theirs.id } })).toBeNull();
  });

  it("holds a pet's details to the same rule", async () => {
    const rex = await db.person.create({ data: { name: "Rex", kind: "PET", species: "DOG", createdById: admin } });
    const fd = new FormData();
    fd.set("name", "Biscuit");
    fd.set("species", "DOG");
    who.role = "MEMBER";
    who.id = member;
    await expect(updatePet(rex.id, fd)).rejects.toThrow(/added them/);
    who.role = "ADMIN";
    who.id = admin;
    await updatePet(rex.id, fd);
    expect((await db.person.findUniqueOrThrow({ where: { id: rex.id } })).name).toBe("Biscuit");
    // A pet is removed, not forgotten; forgetting would leave its animal matches pointing at nobody.
    await expect(optOutPerson(rex.id, form())).rejects.toThrow(/pet/);
  });
});
