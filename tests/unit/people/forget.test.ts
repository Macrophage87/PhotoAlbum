import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { annotationSchema } from "@/lib/annotation/schema";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "ADMIN" as "MEMBER" | "ADMIN", id: "" }));
const redirected = vi.hoisted(() => ({ to: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => void (redirected.to = to) }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { optOutPerson, recordAdultAndName, setNameInDescriptions, tagPersonAt, untagPersonAt, updatePerson, updatePet } from "@/app/people/actions";
import { applyAnnotation } from "@/lib/annotation/apply";
import { applyPlaceEstimate } from "@/lib/annotation/place";
import { scrubWithdrawnNames } from "@/lib/people/forget";
import { loadItem, withoutUnpermittedNames } from "@/lib/annotation/request";
import { withoutUnpermittedNames as withoutContainerNames } from "@/lib/annotation/container";

const annotation: StoredAnnotation = {
  title: "Ada Byron at the lake",
  caption: "Ada Byron wading in at the lake",
  description: "Ada Byron and Ben spend the afternoon at the lake. Ada's dog swims out to the raft.",
  tags: ["lake", "ada byron", "ada's dog", "adapter"],
  place: "Ada Byron's cabin",
  activity: "swimming",
  objects: ["raft", "ada byron's hat"],
  visibleText: null,
  season: "summer",
  mood: "happy",
  searchSummary: "ada byron lake swim summer ben",
};

const form = (mode?: string) => {
  const fd = new FormData();
  if (mode) fd.set("mode", mode);
  return fd;
};

const vector384 = `[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

describe("forgetting somebody", () => {
  let admin: string, member: string, photoId: string, mentioned: string, handTitled: string, adaId: string, tripId: string, activityId: string, collectionId: string, ownTripId: string;

  const photo = (name: string, data: Record<string, unknown>) =>
    db.photo.create({ data: { uploaderId: admin, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", ...data } }).then((p) => p.id);

  beforeEach(async () => {
    await resetTestDb();
    redirected.to = "";
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    member = (await db.user.create({ data: { email: "member@example.com", role: "MEMBER", name: "Cousin Pat" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    adaId = (await db.person.create({ data: { name: "Ada Byron", birthday: new Date("1950-01-01"), faceIndexing: true, nameInDescriptions: true, createdById: member } })).id;
    // Descriptions the helper wrote, and one a member wrote by hand.
    tripId = (await db.trip.create({ data: { slug: "lake", title: "The lake", description: "A week at the lake. Ada swam every morning.", descriptionByHelper: true, startDate: new Date("2026-07-01"), endDate: new Date("2026-07-07"), createdById: admin } })).id;
    ownTripId = (await db.trip.create({ data: { slug: "elsewhere", title: "Elsewhere", description: "Ada Byron came too.", startDate: new Date("2026-08-01"), endDate: new Date("2026-08-02"), createdById: admin } })).id;
    activityId = (await db.activity.create({ data: { tripId, title: "Swim", startTime: new Date("2026-07-02T09:00:00Z"), endTime: new Date("2026-07-02T10:00:00Z"), description: "Ada and Ben swam to the raft.", descriptionByHelper: true } })).id;
    collectionId = (await db.collection.create({ data: { slug: "summer", title: "Summer", description: "Summer with Ada, in Canada.", descriptionByHelper: true, createdById: admin } })).id;
    // Titled by the helper (the item's title is its record's title).
    photoId = await photo("a.jpg", { tripId, activityId, title: "Ada Byron at the lake", caption: "Our day out", annotation, annotatedAt: new Date(), estimatedDateNote: "1990–1995: Ada looks about ten", placeEstimateName: "Ada Byron's cabin, Maine", placeEstimateNote: "the sign reads Ada Byron's cabin" });
    await db.$executeRawUnsafe(`UPDATE "Photo" SET "textEmbedding" = '${vector384}'::vector WHERE id = $1`, photoId);
    await db.collectionItem.create({ data: { collectionId, photoId, addedById: admin } });
    await db.mediaAnnotationRaw.create({ data: { photoId, model: "m", response: { text: "Ada Byron at the lake" } } });
    // Nobody tagged her here, but the helper's text names her in full all the same (from the notes, or a tag since
    // removed), and gave the item the title it goes by for members.
    mentioned = await photo("b.jpg", { membersTitle: "Ada Byron on the porch", annotation: { ...annotation, title: "Ada Byron on the porch" }, annotatedAt: new Date() });
    // A member titled this one themselves, and captioned it: their words.
    handTitled = await photo("c.jpg", { title: "Ada Byron's 80th", caption: "Ada blowing out candles", context: "Ada's birthday", annotation: { ...annotation, title: "A birthday cake" }, annotatedAt: new Date() });
    await db.face.create({ data: { photoId, personId: adaId, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0.9 } });
    await db.face.create({ data: { photoId: handTitled, personId: adaId, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
  });

  const found = async (column: "searchVector" | "searchVectorMembers", word: string) =>
    (await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "Photo" WHERE "${column}" @@ plainto_tsquery('simple', $1)`, word)).map((r) => r.id).sort();

  it("takes the name out of everything the helper wrote, wherever it is", async () => {
    await optOutPerson(adaId, form());

    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.title).toBe("A family member at the lake");
    const a = p.annotation as StoredAnnotation;
    expect(a.title).toBe("A family member at the lake");
    expect(a.description).toBe("A family member and Ben spend the afternoon at the lake. A family member's dog swims out to the raft.");
    // Tags that name her go; a tag with only her first name in it, or merely the letters, stays.
    expect(a.tags).toEqual(["lake", "ada's dog", "adapter"]);
    expect(a.objects).toEqual(["raft"]);
    expect(p.estimatedDateNote).toBe("1990–1995: a family member looks about ten");
    expect(p.placeEstimateName).toBe("A family member's cabin, Maine");
    expect(p.placeEstimateNote).toBe("the sign reads a family member's cabin");
    expect(p.namesScrubbedAt).not.toBeNull();
    expect((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Photo" WHERE id = ${photoId} AND "textEmbedding" IS NOT NULL`)[0].n).toBe(0);
    expect(await db.mediaAnnotationRaw.count({ where: { photoId } })).toBe(0);

    // Found by what the helper wrote, not only by a tag.
    const m = await db.photo.findUniqueOrThrow({ where: { id: mentioned } });
    expect(m.membersTitle).toBe("A family member on the porch");
    expect((m.annotation as StoredAnnotation).caption).toBe("A family member wading in at the lake");

    // The helper's descriptions are rewritten; the one a member wrote is theirs.
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).description).toBe("A week at the lake. A family member swam every morning.");
    expect((await db.activity.findUniqueOrThrow({ where: { id: activityId } })).description).toBe("A family member and Ben swam to the raft.");
    expect((await db.collection.findUniqueOrThrow({ where: { id: collectionId } })).description).toBe("Summer with a family member, in Canada.");
    expect((await db.trip.findUniqueOrThrow({ where: { id: ownTripId } })).description).toBe("Ada Byron came too.");

    // A member's own title, caption and notes are left as they wrote them, and listed on the page after.
    const h = await db.photo.findUniqueOrThrow({ where: { id: handTitled } });
    expect(h).toMatchObject({ title: "Ada Byron's 80th", caption: "Ada blowing out candles", context: "Ada's birthday" });
    expect((h.annotation as StoredAnnotation).caption).toBe("A family member wading in at the lake");
    const q = new URLSearchParams(redirected.to.split("?")[1]);
    expect(redirected.to.startsWith("/people/forgotten?")).toBe(true);
    expect(q.get("p")).toBe(handTitled);
    expect(q.get("t")).toBe("elsewhere");
    expect(redirected.to).not.toMatch(/ada/i);

    expect(await found("searchVectorMembers", "byron")).toEqual([handTitled]);
    expect(await db.person.findUnique({ where: { id: adaId } })).toBeNull();
  });

  it("scrubs the same way when they keep their name on the photographs, and can be run again", async () => {
    await optOutPerson(adaId, form("keep-name"));
    await optOutPerson(adaId, form("keep-name"));
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).title).toBe("A family member at the lake");
    const ada = await db.person.findUniqueOrThrow({ where: { id: adaId } });
    expect(ada.optedOutAt).not.toBeNull();
    expect(ada.nameInDescriptions).toBe(false);
    // The confirmed appearance stays as a plain record, but her name is out of the members' index.
    expect(await db.face.count({ where: { personId: adaId, status: "CONFIRMED" } })).toBe(2);
    expect(await found("searchVectorMembers", "byron")).toEqual([handTitled]);
  });

  it("finds her under a name she no longer goes by", async () => {
    const rename = new FormData();
    rename.set("name", "Ada King");
    await updatePerson(adaId, rename);
    expect((await db.person.findUniqueOrThrow({ where: { id: adaId } })).formerNames).toEqual(["Ada Byron"]);
    await optOutPerson(adaId, form("keep-name"));
    // (Renaming moved the helper's title, which names her, to the members' title; either way it is scrubbed.)
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.title ?? p.membersTitle).toBe("A family member at the lake");
  });

  it("leaves somebody else with the same first name alone", async () => {
    await db.person.update({ where: { id: adaId }, data: { name: "Grace Hopper" } });
    await db.person.create({ data: { name: "Grace Kelly", createdById: admin } });
    const both = await photo("d.jpg", { annotation: { ...annotation, title: "Grace Kelly and Grace Hopper", caption: "Grace waves" }, annotatedAt: new Date() });
    await db.face.create({ data: { photoId: both, personId: adaId, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await optOutPerson(adaId, form("keep-name"));
    const a = (await db.photo.findUniqueOrThrow({ where: { id: both } })).annotation as StoredAnnotation;
    expect(a.title).toBe("Grace Kelly and a family member");
    // "Grace" alone could be either of them, so it is left.
    expect(a.caption).toBe("Grace waves");
  });

  it("does not let an answer asked for before the forget write her name back", async () => {
    const before = new Date(Date.now() - 60_000);
    await optOutPerson(adaId, form("keep-name"));
    const answer = annotationSchema.parse({ ...annotation, estimatedYear: null, estimatedPlace: null });
    await applyAnnotation(photoId, "m", answer, { content: [] }, { requestedAt: before });
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect((p.annotation as StoredAnnotation).title).toBe("A family member at the lake");
    expect(p.annotationError).toBe("names_changed");
    expect(await db.mediaAnnotationRaw.count({ where: { photoId } })).toBe(0);
    expect(await applyPlaceEstimate(photoId, { name: "Ada Byron's cabin", precision: "exact", lat: 44, lng: -68, radiusM: 100, confidence: 0.9, evidence: "Ada Byron's sign" }, { requestedAt: before })).toBe("stale");
    // Asked for after, it is stored as usual.
    await applyAnnotation(photoId, "m", answer, { content: [] }, { requestedAt: new Date() });
    expect(await db.mediaAnnotationRaw.count({ where: { photoId } })).toBe(1);
  });

  it("does not store an answer asked for before somebody on it withdrew their agreement", async () => {
    const before = new Date(Date.now() - 60_000);
    await setNameInDescriptions(adaId, false);
    await db.person.update({ where: { id: adaId }, data: { faceIndexing: false } });
    const answer = annotationSchema.parse({ ...annotation, estimatedYear: null, estimatedPlace: null });
    await applyAnnotation(photoId, "m", answer, { content: [] }, { requestedAt: before });
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotationError).toBe("names_changed");
  });

  it("throws away an answer only for a change to how they may be named, not for any edit", async () => {
    const before = new Date(Date.now() - 60_000);
    const answer = annotationSchema.parse({ ...annotation, estimatedYear: null, estimatedPlace: null });
    // A relationship edit, or the nightly "needs a decision" flag, says nothing about their name.
    await db.person.update({ where: { id: adaId }, data: { relationship: "grandmother", pendingDecision: true } });
    await applyAnnotation(photoId, "m", answer, { content: [] }, { requestedAt: before });
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotationError).toBeNull();
    // A birthday does.
    await db.person.update({ where: { id: adaId }, data: { birthday: new Date("2015-01-01") } });
    await applyAnnotation(photoId, "m", answer, { content: [] }, { requestedAt: before });
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotationError).toBe("names_changed");
  });

  it("never hands the helper a name it may not be told, in a member's title or an old description", async () => {
    // Recognition and naming off: Ada Byron may not be named to the helper.
    await db.person.update({ where: { id: adaId }, data: { faceIndexing: false, nameInDescriptions: false } });
    const item = await loadItem(handTitled);
    const safe = await withoutUnpermittedNames(item!);
    expect(safe.title).toBe("A family member's 80th");
    const container = { description: "Ada Byron came too.", descriptionByHelper: false, photos: [{ id: handTitled, title: "Ada Byron's 80th", titleByHelper: false, annotation: null }] };
    const c = await withoutContainerNames(container);
    expect(c.description).toBe("A family member came too.");
    expect(c.photos[0].title).toBe("A family member's 80th");
    // The helper's own old words are not handed back at all.
    expect((await withoutContainerNames({ ...container, descriptionByHelper: true })).description).toBeNull();
  });

  it("takes the name off one photograph's text when its tag is taken off", async () => {
    await db.face.deleteMany({ where: { photoId } });
    const fd = new FormData();
    fd.set("personId", adaId);
    fd.set("box", JSON.stringify([0.3, 0.2, 0.16, 0.22]));
    await tagPersonAt(photoId, fd);
    const tag = await db.face.findFirstOrThrow({ where: { photoId, personId: adaId } });
    await untagPersonAt(tag.id);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).title).toBe("A family member at the lake");
    // Only that photograph: the trip's description was written from many, and is left.
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).description).toBe("A week at the lake. Ada swam every morning.");
  });

  it("is only for whoever added the person, and admins", async () => {
    const stranger = (await db.user.create({ data: { email: "s@example.com", role: "MEMBER" } })).id;
    who.role = "MEMBER";
    who.id = stranger;
    await expect(optOutPerson(adaId, form())).rejects.toThrow(/added them/);
    await expect(optOutPerson(adaId, form("keep-name"))).rejects.toThrow(/added them/);
    const rename = new FormData();
    rename.set("name", "Somebody else");
    await expect(updatePerson(adaId, rename)).rejects.toThrow(/added them/);
    // Nothing happened: her tags, her record and the text are all as they were.
    expect(await db.face.count({ where: { personId: adaId } })).toBe(2);
    expect((await db.person.findUniqueOrThrow({ where: { id: adaId } })).name).toBe("Ada Byron");
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).title).toBe("Ada Byron at the lake");

    // The member who added her may rename and forget her.
    who.id = member;
    await updatePerson(adaId, rename);
    expect((await db.person.findUniqueOrThrow({ where: { id: adaId } })).name).toBe("Somebody else");
    await optOutPerson(adaId, form());
    expect(await db.person.findUnique({ where: { id: adaId } })).toBeNull();
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
    expect(await db.person.findUniqueOrThrow({ where: { id: rex.id } })).toMatchObject({ name: "Biscuit", formerNames: ["Rex"] });
    // A pet is removed, not forgotten; forgetting would leave its animal matches pointing at nobody.
    await expect(optOutPerson(rex.id, form())).rejects.toThrow(/pet/);
  });
});

describe("a name handed over without evidence of an adult", () => {
  it("is switched off by the migration, even with no birthday and no confirmation at all", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const sam = await db.person.create({ data: { name: "Sam Lee", nameInDescriptions: true, createdById: admin } });
    const jo = await db.person.create({ data: { name: "Jo March", birthday: new Date("1950-01-01"), nameInDescriptions: true, createdById: admin } });
    const kit = await db.person.create({ data: { name: "Kit Carson", birthday: new Date("1950-01-01"), nameInDescriptionsSetAt: new Date("2026-01-01"), createdById: admin } });
    await db.$queryRaw`SELECT withdraw_unevidenced_naming()`;
    const after = async (id: string) => db.person.findUniqueOrThrow({ where: { id } });
    // Nothing on record to say Sam is an adult: naming is off at once, and the name is due to be scrubbed.
    expect(await after(sam.id)).toMatchObject({ nameInDescriptions: false });
    expect((await after(sam.id)).namingWithdrawnAt).not.toBeNull();
    // Jo is an adult by birthday and stays named.
    expect(await after(jo.id)).toMatchObject({ nameInDescriptions: true, namingWithdrawnAt: null });
    // Kit's naming was turned off before turning it off scrubbed anything: listed too.
    expect((await after(kit.id)).namingWithdrawnAt).not.toBeNull();
  });

  it("is taken out of the helper's text once admins have had their fortnight, and not before", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const sam = await db.person.create({ data: { name: "Sam Lee", namingWithdrawnAt: new Date(), createdById: admin } });
    const photoId = (await db.photo.create({ data: { uploaderId: admin, originalName: "s.jpg", mimeType: "image/jpeg", storageKey: "s", originalPath: "s/o.jpg", sizeBytes: 1, status: "READY", annotation: { ...annotation, caption: "Sam Lee on the swings" }, annotatedAt: new Date() } })).id;
    await db.face.create({ data: { photoId, personId: sam.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    expect(await scrubWithdrawnNames()).toBe(0);
    expect(((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotation as StoredAnnotation).caption).toBe("Sam Lee on the swings");
    expect(await scrubWithdrawnNames(new Date(Date.now() + 15 * 86_400_000))).toBe(1);
    expect(((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotation as StoredAnnotation).caption).toBe("A family member on the swings");
    expect((await db.person.findUniqueOrThrow({ where: { id: sam.id } })).namingWithdrawnAt).toBeNull();
  });

  it("is taken back out when an admin stops using it", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    const jo = await db.person.create({ data: { name: "Jo March", birthday: new Date("1950-01-01"), nameInDescriptions: true, createdById: admin } });
    const photoId = (await db.photo.create({ data: { uploaderId: admin, originalName: "j.jpg", mimeType: "image/jpeg", storageKey: "j", originalPath: "j/o.jpg", sizeBytes: 1, status: "READY", annotation: { ...annotation, caption: "Jo March reading" }, annotatedAt: new Date() } })).id;
    await db.face.create({ data: { photoId, personId: jo.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await setNameInDescriptions(jo.id, false);
    expect(((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotation as StoredAnnotation).caption).toBe("A family member reading");
  });
});

describe("short names", () => {
  it("are taken out only on the photographs their owner is on, and a name shared with somebody else never elsewhere", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    const photo = (name: string, caption: string) => db.photo.create({ data: { uploaderId: admin, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", annotation: { ...annotation, title: "", caption, tags: ["grace", "rose garden"] }, annotatedAt: new Date() } }).then((p) => p.id);
    const grace = await db.person.create({ data: { name: "Grace", createdById: admin } });
    const jo = await db.person.create({ data: { name: "Jo", createdById: admin } });
    await db.person.create({ data: { name: "Jo Smith", createdById: admin } });
    const hers = await photo("g.jpg", "Grace said grace; Jo waved");
    const elsewhere = await photo("e.jpg", "Grace said grace; Jo waved");
    await db.face.create({ data: { photoId: hers, personId: grace.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await db.face.create({ data: { photoId: hers, personId: jo.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await optOutPerson(grace.id, form("keep-name"));
    await optOutPerson(jo.id, form("keep-name"));
    const on = (await db.photo.findUniqueOrThrow({ where: { id: hers } })).annotation as StoredAnnotation;
    expect(on.caption).toBe("A family member said grace; a family member waved");
    expect(on.tags).toEqual(["rose garden"]);
    const off = (await db.photo.findUniqueOrThrow({ where: { id: elsewhere } })).annotation as StoredAnnotation;
    expect(off.caption).toBe("Grace said grace; Jo waved");
    expect(off.tags).toEqual(["grace", "rose garden"]);
  });
});

describe("recording that somebody is an adult, for naming", () => {
  it("names them only once there is evidence, separately from recognition", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    const vi_ = await db.person.create({ data: { name: "Great-Aunt Vi", createdById: admin } });
    await expect(recordAdultAndName(vi_.id, new FormData())).rejects.toThrow(/adult/);
    const fd = new FormData();
    fd.set("attestAdult", "on");
    await recordAdultAndName(vi_.id, fd);
    const after = await db.person.findUniqueOrThrow({ where: { id: vi_.id } });
    expect(after).toMatchObject({ nameInDescriptions: true, faceIndexing: false });
    expect(after.adultAttestedAt).not.toBeNull();
  });
});
