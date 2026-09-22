import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { nameMayLeaveServer } from "@/lib/people/consent";
import { permittedNames } from "@/lib/people/gates";
import { describedBeforeTheirNames } from "@/lib/jobs/handlers/annotation-batch";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "ADMIN" as "MEMBER" | "ADMIN", id: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { setNameInDescriptions, tagPersonAt, untagPersonAt } from "@/app/people/actions";

const adult = { birthday: new Date("1950-01-01"), adultAttestedAt: null };

describe("who may be named in a description", () => {
  it("lets recognition or a naming agreement allow it, and neither means no", () => {
    expect(nameMayLeaveServer({ ...adult, faceIndexing: true, nameInDescriptions: false })).toBe(true);
    // The narrower agreement on its own: named, but no template of them is kept and nothing is recognised.
    expect(nameMayLeaveServer({ ...adult, faceIndexing: false, nameInDescriptions: true })).toBe(true);
    expect(nameMayLeaveServer({ ...adult, faceIndexing: false, nameInDescriptions: false })).toBe(false);
    // Missing altogether is the same as off, for the callers that do not select the column.
    expect(nameMayLeaveServer({ ...adult, faceIndexing: false })).toBe(false);
  });

  it("never names a child, whatever has been agreed", () => {
    const child = { birthday: new Date(Date.now() - 8 * 365.25 * 86_400_000), adultAttestedAt: null };
    expect(nameMayLeaveServer({ ...child, faceIndexing: true, nameInDescriptions: true })).toBe(false);
  });
});

describe("tagging somebody on a photograph", () => {
  let me: string, photoId: string;

  beforeEach(async () => {
    await resetTestDb();
    who.role = "ADMIN";
    me = (await db.user.create({ data: { email: "x@example.com", role: "ADMIN" } })).id;
    who.id = me;
    photoId = (await db.photo.create({ data: { uploaderId: me, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: "a", originalPath: "a/o.jpg", sizeBytes: 1, status: "READY", width: 1200, height: 800 } })).id;
  });

  const tag = (over: Record<string, string>) => {
    const fd = new FormData();
    fd.set("box", JSON.stringify([0.3, 0.2, 0.16, 0.22]));
    for (const [k, v] of Object.entries(over)) fd.set(k, v);
    return tagPersonAt(photoId, fd);
  };

  it("writes down who is where, with no template and nothing recognized", async () => {
    await tag({ name: "Grandma Jo" });
    const face = await db.face.findFirstOrThrow({ where: { photoId }, include: { person: true } });
    expect(face.person?.name).toBe("Grandma Jo");
    expect(face.status).toBe("CONFIRMED");
    expect(face.box).toEqual([0.3, 0.2, 0.16, 0.22]);
    // A hand tag is a caption with a position: no confidence, no template, no group.
    expect(face.confidence).toBe(0);
    expect(face.clusterId).toBeNull();
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Face" WHERE embedding IS NOT NULL`)[0].n).toBe(0);
    // Somebody named this way has nothing switched on: those are an admin's decisions, and this was a caption.
    expect(face.person).toMatchObject({ faceIndexing: false, nameInDescriptions: false, pendingDecision: false });
  });

  it("moves a person's box rather than stacking a second tag on the same photograph", async () => {
    await tag({ name: "Grandma Jo" });
    const person = await db.person.findFirstOrThrow({ where: { name: "Grandma Jo" } });
    const fd = new FormData();
    fd.set("personId", person.id);
    fd.set("box", JSON.stringify([0.6, 0.1, 0.16, 0.22]));
    await tagPersonAt(photoId, fd);
    const faces = await db.face.findMany({ where: { photoId } });
    expect(faces).toHaveLength(1);
    expect(faces[0].box).toEqual([0.6, 0.1, 0.16, 0.22]);
  });

  it("is only for the people whose photograph it is", async () => {
    const someoneElse = await db.user.create({ data: { email: "them@example.com", role: "MEMBER" } });
    const theirs = await db.photo.create({ data: { uploaderId: someoneElse.id, originalName: "b.jpg", mimeType: "image/jpeg", storageKey: "b", originalPath: "b/o.jpg", sizeBytes: 1, status: "READY" } });
    who.role = "MEMBER";
    const fd = new FormData();
    fd.set("name", "Anyone");
    fd.set("box", JSON.stringify([0.1, 0.1, 0.2, 0.2]));
    await expect(tagPersonAt(theirs.id, fd)).rejects.toThrow();
  });

  it("takes a hand tag off again, and refuses to touch one the album found", async () => {
    await tag({ name: "Grandma Jo" });
    const hand = await db.face.findFirstOrThrow({ where: { photoId } });
    const found = await db.face.create({ data: { photoId, box: [0.1, 0.1, 0.2, 0.2], confidence: 0.9, status: "DETECTED" } });
    await expect(untagPersonAt(found.id)).rejects.toThrow(/found by the album/);
    await untagPersonAt(hand.id);
    expect(await db.face.findUnique({ where: { id: hand.id } })).toBeNull();
    expect(await db.face.findUnique({ where: { id: found.id } })).not.toBeNull();
  });

  it("hands a tagged person's name to the helper once an admin records that they agree", async () => {
    await tag({ name: "Grandma Jo" });
    const person = await db.person.findFirstOrThrow({ where: { name: "Grandma Jo" } });
    await db.person.update({ where: { id: person.id }, data: { birthday: new Date("1946-03-02") } });
    // Tagged but not agreed: the helper is told nothing, and writes "an older couple".
    expect(await permittedNames(photoId)).toEqual([]);
    await setNameInDescriptions(person.id, true);
    expect(await permittedNames(photoId)).toEqual(["Grandma Jo"]);
    await setNameInDescriptions(person.id, false);
    expect(await permittedNames(photoId)).toEqual([]);
  });

  it("hands over a pet the animal matcher found and somebody agreed with, not only a tagged one", async () => {
    // A pet reaches a photograph two ways. Only the tag was looked at, so a dog the album had correctly recognised
    // was still described as "a dog".
    const biscuit = await db.person.create({ data: { name: "Biscuit", kind: "PET", createdById: me } });
    await db.animalDetection.create({ data: { photoId, personId: biscuit.id, species: "DOG", status: "CONFIRMED", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, confidence: 0.9 } });
    expect(await permittedNames(photoId)).toEqual(["Biscuit"]);
  });

  it("will not record an agreement for somebody who asked to be forgotten", async () => {
    const gone = await db.person.create({ data: { name: "Gone", optedOutAt: new Date(), createdById: me } });
    await expect(setNameInDescriptions(gone.id, true)).rejects.toThrow(/forgotten/);
  });
});

describe("which items were described before the album knew who was in them", () => {
  let me: string;

  const photo = async (name: string, annotatedAt: Date | null) =>
    (await db.photo.create({ data: { uploaderId: me, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", annotatedAt } })).id;

  beforeEach(async () => {
    await resetTestDb();
    who.role = "ADMIN";
    me = (await db.user.create({ data: { email: "x@example.com", role: "ADMIN" } })).id;
    who.id = me;
  });

  it("picks the ones whose people were named after the description, and nothing else", async () => {
    const long = new Date("2026-01-01T00:00:00Z");
    const described = await photo("described.jpg", long);
    const undescribed = await photo("never.jpg", null);
    const jo = await db.person.create({ data: { name: "Jo", birthday: new Date("1946-03-02"), nameInDescriptions: true, nameInDescriptionsSetById: me, nameInDescriptionsSetAt: long, createdById: me } });

    // Nobody tagged yet: nothing to re-ask about.
    expect(await describedBeforeTheirNames()).toEqual([]);

    // Tagged after it was described: exactly the case this run is for.
    await db.face.create({ data: { photoId: described, personId: jo.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    await db.face.create({ data: { photoId: undescribed, personId: jo.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    // An item never described at all belongs to the ordinary describe run, not this one.
    expect(await describedBeforeTheirNames()).toEqual([described]);

    // Describing it again moves it past the tag, so the run clears itself rather than going round for ever.
    await db.photo.update({ where: { id: described }, data: { annotatedAt: new Date() } });
    expect(await describedBeforeTheirNames()).toEqual([]);
  });

  it("counts an agreement given after the description, not only a tag added after it", async () => {
    const early = new Date("2026-01-01T00:00:00Z");
    const item = await photo("described.jpg", new Date("2026-02-01T00:00:00Z"));
    const dan = await db.person.create({ data: { name: "Dan", birthday: new Date("1970-01-15"), createdById: me } });
    await db.face.create({ data: { photoId: item, personId: dan.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0, createdAt: early } });
    // Tagged long before, so the description had its chance — until the agreement to be named arrived today.
    expect(await describedBeforeTheirNames()).toEqual([]);
    await setNameInDescriptions(dan.id, true);
    expect(await describedBeforeTheirNames()).toEqual([item]);
  });

  it("narrows to one person when asked, so agreeing for a relative does not redo everybody's photographs", async () => {
    const long = new Date("2026-01-01T00:00:00Z");
    const hers = await photo("hers.jpg", long);
    const his = await photo("his.jpg", long);
    const jo = await db.person.create({ data: { name: "Jo", birthday: new Date("1946-03-02"), nameInDescriptions: true, nameInDescriptionsSetById: me, nameInDescriptionsSetAt: long, createdById: me } });
    const al = await db.person.create({ data: { name: "Al", birthday: new Date("1944-05-06"), nameInDescriptions: true, nameInDescriptionsSetById: me, nameInDescriptionsSetAt: long, createdById: me } });
    await db.face.create({ data: { photoId: hers, personId: jo.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    await db.face.create({ data: { photoId: his, personId: al.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    expect((await describedBeforeTheirNames()).sort()).toEqual([hers, his].sort());
    expect(await describedBeforeTheirNames(jo.id)).toEqual([hers]);
    expect(await describedBeforeTheirNames(al.id)).toEqual([his]);
  });

  it("re-asks for a pet the matcher found, not only one somebody tagged", async () => {
    const item = await photo("described.jpg", new Date("2026-01-01T00:00:00Z"));
    const biscuit = await db.person.create({ data: { name: "Biscuit", kind: "PET", species: "DOG", createdById: me } });
    await db.animalDetection.create({ data: { photoId: item, personId: biscuit.id, species: "DOG", status: "CONFIRMED", box: { x: 0, y: 0, w: 1, h: 1 }, confidence: 0.9 } });
    expect(await describedBeforeTheirNames()).toEqual([item]);
    expect(await describedBeforeTheirNames(biscuit.id)).toEqual([item]);
  });

  it("leaves a child out of it", async () => {
    const item = await photo("described.jpg", new Date("2026-01-01T00:00:00Z"));
    const kid = await db.person.create({ data: { name: "Sam", birthday: new Date(Date.now() - 8 * 365.25 * 86_400_000), nameInDescriptions: true, createdById: me } });
    await db.face.create({ data: { photoId: item, personId: kid.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    expect(await describedBeforeTheirNames()).toEqual([]);
  });

  it("re-asks for a pet, whose name needs no agreement", async () => {
    const item = await photo("described.jpg", new Date("2026-01-01T00:00:00Z"));
    const biscuit = await db.person.create({ data: { name: "Biscuit", kind: "PET", species: "DOG", createdById: me } });
    await db.face.create({ data: { photoId: item, personId: biscuit.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    expect(await describedBeforeTheirNames()).toEqual([item]);
  });
});
