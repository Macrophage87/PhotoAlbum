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

import { decideIndexing, optOutPerson, recordAdultAndName, setNameInDescriptions, tagPersonAt, untagPersonAt, updatePerson, updatePet } from "@/app/people/actions";
import { applyAnnotation } from "@/lib/annotation/apply";
import { applyPlaceEstimate } from "@/lib/annotation/place";
import { readFileSync } from "node:fs";
import { scrubWithdrawnNames, withdrawalNotice, withdrawalReason } from "@/lib/people/forget";
import { setAnnotationShared } from "@/app/annotation/actions";
import { loadItem, withoutUnpermittedNames } from "@/lib/annotation/request";
import { unpermittedNameScrub } from "@/lib/people/unpermitted";
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
    // On her own photograph every word of her name is hers in the keywords; "adapter" is not a word of it.
    expect(a.tags).toEqual(["lake", "adapter"]);
    expect(a.objects).toEqual(["raft"]);
    expect(p.estimatedDateNote).toBe("1990–1995: a family member looks about ten");
    expect(p.placeEstimateName).toBe("A family member's cabin, Maine");
    expect(p.placeEstimateNote).toBe("the sign reads a family member's cabin");
    // Not stamped: which photographs a forget covered is not written on them (see forgetState).
    expect(p.namesScrubbedAt).toBeNull();
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
    // Listed until an admin dismisses it: ids and fields, never the name.
    expect(redirected.to).toBe("/people/forgotten?done=1");
    const [left] = await db.forgetLeftover.findMany();
    const items = left.items as { photos: { id: string; fields: string[] }[]; trips: { id: string }[] };
    expect(items.photos.map((x) => x.id)).toEqual([handTitled]);
    expect(items.photos[0].fields).toEqual(["title", "caption", "notes"]);
    // Trips by id: an address can be the name.
    expect(items.trips.map((t) => t.id)).toContain(ownTripId);
    expect(JSON.stringify(left.items)).not.toMatch(/ada|byron/i);
    // Not stamped either: an answer already on its way about any photograph is thrown away (see forgetState).
    expect((await db.photo.findUniqueOrThrow({ where: { id: handTitled } })).namesScrubbedAt).toBeNull();

    expect(await found("searchVectorMembers", "byron")).toEqual([handTitled]);
    expect(await db.person.findUnique({ where: { id: adaId } })).toBeNull();
  });

  it("never rewrites an embedded video's own title, whatever it was recorded as", async () => {
    // YouTube's title, which the members_only_text migration recorded as the helper's for matching its record.
    const video = await photo("v.jpg", { kind: "EXTERNAL_VIDEO", title: "Ada Byron at the lake", titleByHelper: true, annotation, annotatedAt: new Date() });
    await db.face.create({ data: { photoId: video, personId: adaId, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    await optOutPerson(adaId, form());
    const v = await db.photo.findUniqueOrThrow({ where: { id: video } });
    expect(v.title).toBe("Ada Byron at the lake");
    expect((v.annotation as StoredAnnotation).caption).toBe("A family member wading in at the lake");
    // Left as it is, and listed with the rest of what members' words say.
    const [left] = await db.forgetLeftover.findMany();
    expect((left.items as { photos: { id: string; fields: string[] }[] }).photos.find((x) => x.id === video)?.fields).toEqual(["title"]);
  });

  it("scrubs the same way when they keep their name on the photographs, and can be run again", async () => {
    await optOutPerson(adaId, form("keep-name"));
    await optOutPerson(adaId, form("keep-name"));
    // Back to her page, which says what was done.
    expect(redirected.to).toBe(`/people/${adaId}?forgot=face`);
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

  it("takes her first name on her photographs, but leaves somebody else with it alone", async () => {
    await db.person.update({ where: { id: adaId }, data: { name: "Grace Hopper" } });
    const kelly = await db.person.create({ data: { name: "Grace Kelly", createdById: admin } });
    const hers = await photo("d.jpg", { annotation: { ...annotation, title: "Grace Kelly and Grace Hopper", caption: "Grace waves", tags: ["grace", "hopper family", "lake"] }, annotatedAt: new Date() });
    const both = await photo("e.jpg", { annotation: { ...annotation, title: "Grace and Grace", caption: "Grace waves", tags: ["grace", "lake"] }, annotatedAt: new Date() });
    await db.face.create({ data: { photoId: hers, personId: adaId, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await db.face.create({ data: { photoId: both, personId: adaId, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await db.face.create({ data: { photoId: both, personId: kelly.id, status: "CONFIRMED", box: [0.5, 0, 0.5, 1], confidence: 0 } });
    await optOutPerson(adaId, form("keep-name"));
    const a = (await db.photo.findUniqueOrThrow({ where: { id: hers } })).annotation as StoredAnnotation;
    // On her photograph "Grace" is her — an everyday word and another Grace notwithstanding — but "Grace Kelly" is not.
    expect(a.title).toBe("Grace Kelly and a family member");
    expect(a.caption).toBe("A family member waves");
    // "grace" alone is her there; "hopper family" is a surname in a keyword, which could as well be a place or a thing.
    expect(a.tags).toEqual(["hopper family", "lake"]);
    // Where the other Grace is tagged too, "Grace" alone could be either of them, so it is left.
    const b = (await db.photo.findUniqueOrThrow({ where: { id: both } })).annotation as StoredAnnotation;
    expect(b.caption).toBe("Grace waves");
    expect(b.tags).toEqual(["grace", "lake"]);
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
    // Her caption and the notes go without her name as well; "Ada" alone is hers on her own photograph.
    expect(safe).toMatchObject({ caption: "A family member blowing out candles", context: "A family member's birthday" });
    const container = { description: "Ada Byron came too.", descriptionByHelper: false, photos: [{ id: handTitled, title: "Ada Byron's 80th", titleByHelper: false, annotation: null }] };
    const c = await withoutContainerNames(container);
    expect(c.description).toBe("A family member came too.");
    expect(c.photos[0].title).toBe("A family member's 80th");
    // The helper's own old words are not handed back at all.
    expect((await withoutContainerNames({ ...container, descriptionByHelper: true })).description).toBeNull();
  });

  it("counts somebody not to be named as on a trip described as a whole, whichever of its photographs are shown", async () => {
    const sam = await db.person.create({ data: { name: "Sam Lee", createdById: admin } });
    const trip = await db.trip.create({ data: { slug: "sam5", title: "Sam's 5th birthday", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } });
    const shown = (await db.photo.create({ data: { uploaderId: admin, originalName: "s1.jpg", mimeType: "image/jpeg", storageKey: "s1", originalPath: "s1/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    const unshown = (await db.photo.create({ data: { uploaderId: admin, originalName: "s2.jpg", mimeType: "image/jpeg", storageKey: "s2", originalPath: "s2/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    await db.face.create({ data: { photoId: unshown, personId: sam.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const scrub = await unpermittedNameScrub([shown], undefined, [{ kind: "trip", id: trip.id }]);
    expect(scrub("Sam's 5th birthday")).toBe("A family member's 5th birthday");
  });

  it("counts somebody not to be named as on every photograph of a trip they are tagged in", async () => {
    const sam = await db.person.create({ data: { name: "Sam Kent", createdById: admin } });
    const trip = await db.trip.create({ data: { slug: "sam5k", title: "Sam's 5th birthday", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } });
    const tagged = (await db.photo.create({ data: { uploaderId: admin, originalName: "k1.jpg", mimeType: "image/jpeg", storageKey: "k1", originalPath: "k1/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    const other = (await db.photo.create({ data: { uploaderId: admin, originalName: "k2.jpg", mimeType: "image/jpeg", storageKey: "k2", originalPath: "k2/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id, caption: "Sam blowing candles" } })).id;
    await db.face.create({ data: { photoId: tagged, personId: sam.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const safe = await withoutUnpermittedNames((await loadItem(other))!);
    expect(safe.caption).toBe("A family member blowing candles");
    expect(safe.trip?.title).toBe("A family member's 5th birthday");
  });

  it("reads a place-like name as the place on a trip-mate's photograph", async () => {
    const charlotte = await db.person.create({ data: { name: "Charlotte Smith", createdById: admin } });
    const trip = await db.trip.create({ data: { slug: "clt", title: "Charlotte, NC 2020", startDate: new Date("2020-07-01"), endDate: new Date("2020-07-01"), createdById: admin } });
    const hers = (await db.photo.create({ data: { uploaderId: admin, originalName: "c1.jpg", mimeType: "image/jpeg", storageKey: "c1", originalPath: "c1/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    const rain = (await db.photo.create({ data: { uploaderId: admin, originalName: "c2.jpg", mimeType: "image/jpeg", storageKey: "c2", originalPath: "c2/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id, caption: "Charlotte in the rain" } })).id;
    await db.face.create({ data: { photoId: hers, personId: charlotte.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    expect(await withoutUnpermittedNames((await loadItem(rain))!)).toMatchObject({ caption: "Charlotte in the rain", trip: { title: "Charlotte, NC 2020" } });
  });

  it("takes the first name of somebody waiting to be forgotten out of everything, and out of answers", async () => {
    await db.person.create({ data: { name: "Ximena Ortiz", forgetPendingAt: new Date(), optedOutAt: new Date(), createdById: admin } });
    const elsewhere = (await db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "x", originalPath: "x/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    const scrub = await unpermittedNameScrub([elsewhere]);
    expect(scrub("Ximena's graduation")).toBe("A family member's graduation");
    await applyAnnotation(elsewhere, "m", annotationSchema.parse({ ...annotation, caption: "Ximena with a trout", estimatedYear: null, estimatedPlace: null }), { content: [] }, { requestedAt: new Date() });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: elsewhere } })).annotation as StoredAnnotation).caption).toBe("A family member with a trout");
  });

  it("away from their photographs, takes only full names out of what the helper is sent", async () => {
    await db.person.update({ where: { id: adaId }, data: { faceIndexing: false, nameInDescriptions: false } });
    await db.person.create({ data: { name: "Florence Adams", createdById: admin } });
    const elsewhere = (await db.photo.create({ data: { uploaderId: admin, originalName: "e.jpg", mimeType: "image/jpeg", storageKey: "e", originalPath: "e/o.jpg", sizeBytes: 1, status: "READY", title: "Train to Florence", context: "Ada waved; then Ada Byron laughed" } })).id;
    const safe = await withoutUnpermittedNames((await loadItem(elsewhere))!);
    expect(safe.title).toBe("Train to Florence");
    expect(safe.context).toBe("Ada waved; then a family member laughed");
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
    // Recognised on a parent's instruction, never named: nothing to withdraw.
    const kid = await db.person.create({ data: { name: "Tim Carson", birthday: new Date("2019-01-01"), faceIndexing: true, createdById: admin } });
    // The migration drops its function once it has run; bring it back from the migration itself to test it.
    const sql = readFileSync("prisma/migrations/20260926130200_forget_guards/migration.sql", "utf8");
    await db.$executeRawUnsafe(sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION withdraw_unevidenced_naming()"), sql.indexOf("SELECT withdraw_unevidenced_naming();")));
    await db.$queryRaw`SELECT withdraw_unevidenced_naming()`;
    await db.$executeRawUnsafe("DROP FUNCTION withdraw_unevidenced_naming()");
    const after = async (id: string) => db.person.findUniqueOrThrow({ where: { id } });
    // Nothing on record to say Sam is an adult: naming is off at once, and the name is due to be scrubbed.
    expect(await after(sam.id)).toMatchObject({ nameInDescriptions: false });
    expect((await after(sam.id)).namingWithdrawnAt).not.toBeNull();
    // Jo is an adult by birthday and stays named.
    expect(await after(jo.id)).toMatchObject({ nameInDescriptions: true, namingWithdrawnAt: null });
    // Kit's naming was turned off before turning it off scrubbed anything: listed too.
    expect((await after(kit.id)).namingWithdrawnAt).not.toBeNull();
    expect((await after(kid.id)).namingWithdrawnAt).toBeNull();
    // What admins are told, by reason.
    const on = new Date("2026-10-10");
    expect(withdrawalNotice("Sam Lee", withdrawalReason(await after(sam.id)), on)).toMatch(/record a birthday or adult confirmation and turn their name back on/);
    expect(withdrawalNotice("Kit Carson", withdrawalReason(await after(kit.id)), on)).toMatch(/was turned off before; their name will be taken out of old descriptions on/);
    const minor = withdrawalNotice("Tim Carson", withdrawalReason({ birthday: new Date("2019-01-01"), adultAttestedAt: null }), on);
    expect(minor).toMatch(/will be taken out/);
    expect(minor).not.toMatch(/record a birthday/i);
  });

  it("is taken out of the helper's text once admins have had their fortnight, and not before", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const sam = await db.person.create({ data: { name: "Sam Lee", namingWithdrawnAt: new Date(), createdById: admin } });
    // Members-only text waits; what strangers can read (here, a public description and the item's own title) does not.
    const photoId = (await db.photo.create({ data: { uploaderId: admin, originalName: "s.jpg", mimeType: "image/jpeg", storageKey: "s", originalPath: "s/o.jpg", sizeBytes: 1, status: "READY", annotation: { ...annotation, caption: "Sam Lee on the swings" }, annotationMembersOnly: true, annotatedAt: new Date() } })).id;
    const open = (await db.photo.create({ data: { uploaderId: admin, originalName: "o.jpg", mimeType: "image/jpeg", storageKey: "o", originalPath: "o/o.jpg", sizeBytes: 1, status: "READY", title: "Sam Lee at the fair", titleByHelper: true, annotation: { ...annotation, title: "Sam Lee at the fair", caption: "Sam Lee at the fair" }, annotatedAt: new Date() } })).id;
    await db.face.create({ data: { photoId, personId: sam.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await db.face.create({ data: { photoId: open, personId: sam.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    expect(await scrubWithdrawnNames()).toBe(0);
    expect(((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotation as StoredAnnotation).caption).toBe("Sam Lee on the swings");
    const o = await db.photo.findUniqueOrThrow({ where: { id: open } });
    expect(o.title).toBe("A family member at the fair");
    // Only what changed is written: a photograph whose public text never named him is left unstamped.
    const quiet = (await db.photo.create({ data: { uploaderId: admin, originalName: "q.jpg", mimeType: "image/jpeg", storageKey: "q", originalPath: "q/o.jpg", sizeBytes: 1, status: "READY", annotation: { ...annotation, title: "", caption: "A quiet lake" }, annotatedAt: new Date(Date.now() - 86_400_000) } })).id;
    await db.face.create({ data: { photoId: quiet, personId: sam.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await scrubWithdrawnNames();
    expect((await db.photo.findUniqueOrThrow({ where: { id: quiet } })).namesScrubbedAt).toBeNull();
    expect((await db.person.findUniqueOrThrow({ where: { id: sam.id } })).namingPublicScrubbedAt).not.toBeNull();
    expect((o.annotation as StoredAnnotation).caption).toBe("A family member at the fair");
    expect(await scrubWithdrawnNames(new Date(Date.now() + 15 * 86_400_000))).toBe(1);
    expect(((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotation as StoredAnnotation).caption).toBe("A family member on the swings");
    expect((await db.person.findUniqueOrThrow({ where: { id: sam.id } })).namingWithdrawnAt).toBeNull();
  });

  it("leaves an admin's decision alone when naming is turned back on while the fortnight's pass runs", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const sam = await db.person.create({ data: { name: "Sam Lee", namingWithdrawnAt: new Date(Date.now() - 20 * 86_400_000), createdById: admin } });
    const decided = new Date();
    const read = db.person.findMany.bind(db.person);
    // The admin's answer lands after the pass has read who is withdrawn, while it is still working through the album.
    const spy = vi.spyOn(db.person, "findMany").mockImplementationOnce((async (args: Parameters<typeof db.person.findMany>[0]) => {
      const rows = await read(args);
      await db.person.update({ where: { id: sam.id }, data: { nameInDescriptions: true, nameInDescriptionsSetAt: decided, namingWithdrawnAt: null } });
      return rows;
    }) as unknown as typeof db.person.findMany);
    try {
      await scrubWithdrawnNames();
    } finally {
      spy.mockRestore();
    }
    const after = await db.person.findUniqueOrThrow({ where: { id: sam.id } });
    expect(after.nameInDescriptions).toBe(true);
    expect(after.nameInDescriptionsSetAt?.getTime()).toBe(decided.getTime());
  });

  it("in the nightly pass, reaches text shown to everyone since, and photographs tagged since", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const sam = await db.person.create({ data: { name: "Sam Lee", namingWithdrawnAt: new Date(), createdById: admin } });
    const long = new Date(Date.now() - 10 * 86_400_000);
    const shown = (await db.photo.create({ data: { uploaderId: admin, originalName: "s.jpg", mimeType: "image/jpeg", storageKey: "s", originalPath: "s/o.jpg", sizeBytes: 1, status: "READY", annotation: { ...annotation, caption: "Sam Lee fishing" }, annotationMembersOnly: true, annotatedAt: long } })).id;
    const later = (await db.photo.create({ data: { uploaderId: admin, originalName: "l.jpg", mimeType: "image/jpeg", storageKey: "l", originalPath: "l/o.jpg", sizeBytes: 1, status: "READY", annotation: { ...annotation, caption: "Sam on the swings" }, annotatedAt: long } })).id;
    await scrubWithdrawnNames();
    // Shown to everyone after the first pass (not written again), and tagged after it.
    await db.photo.update({ where: { id: shown }, data: { annotationMembersOnly: false, annotationSharedAt: new Date() } });
    await db.face.create({ data: { photoId: later, personId: sam.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await scrubWithdrawnNames();
    expect(((await db.photo.findUniqueOrThrow({ where: { id: shown } })).annotation as StoredAnnotation).caption).toBe("A family member fishing");
    expect(((await db.photo.findUniqueOrThrow({ where: { id: later } })).annotation as StoredAnnotation).caption).toBe("A family member on the swings");
  });

  it("is taken out of the helper's text a member shows to everyone", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    await db.person.create({ data: { name: "Timothy Kent", namingWithdrawnAt: new Date(), createdById: admin } });
    const photoId = (await db.photo.create({ data: { uploaderId: admin, originalName: "t.jpg", mimeType: "image/jpeg", storageKey: "t", originalPath: "t/o.jpg", sizeBytes: 1, status: "READY", annotation: { ...annotation, title: "Timothy Kent fishing", caption: "Timothy Kent fishing" }, membersTitle: "Timothy Kent fishing", annotationMembersOnly: true, annotatedAt: new Date() } })).id;
    const { annotationRevision } = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    await setAnnotationShared(photoId, annotationRevision, true);
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.annotationMembersOnly).toBe(false);
    expect((p.annotation as StoredAnnotation).caption).toBe("A family member fishing");
    expect(p.title).toBe("A family member fishing");
  });

  it("stays pending through a recognition save when naming was turned off before, until naming is turned back on", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    const kit = await db.person.create({ data: { name: "Kit Carson", birthday: new Date("1950-01-01"), namingWithdrawnAt: new Date(), createdById: admin } });
    await decideIndexing(kit.id, new FormData());
    expect((await db.person.findUniqueOrThrow({ where: { id: kit.id } })).namingWithdrawnAt).not.toBeNull();
    await setNameInDescriptions(kit.id, true);
    expect((await db.person.findUniqueOrThrow({ where: { id: kit.id } })).namingWithdrawnAt).toBeNull();
    // Somebody with no evidence at all: recording a birthday through the recognition form is the evidence asked for.
    const sam = await db.person.create({ data: { name: "Sam Lee", namingWithdrawnAt: new Date(), createdById: admin } });
    const fd = new FormData();
    fd.set("birthday", "1960-02-02");
    await decideIndexing(sam.id, fd);
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

describe("where short names are used", () => {
  let admin: string;
  const photo = (name: string, data: Record<string, unknown>) =>
    db.photo.create({ data: { uploaderId: admin, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", annotatedAt: new Date(), ...data } }).then((p) => p.id);
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
  });

  it("finds a safe one-word name anywhere in the album", async () => {
    const sam = await db.person.create({ data: { name: "Sam", createdById: admin } });
    const elsewhere = await photo("s.jpg", { annotation: { ...annotation, title: "Sam at the fair", caption: "Sam at the fair", tags: ["sam's pony"] } });
    await optOutPerson(sam.id, form("keep-name"));
    const a = (await db.photo.findUniqueOrThrow({ where: { id: elsewhere } })).annotation as StoredAnnotation;
    expect(a).toMatchObject({ title: "A family member at the fair", tags: [] });
  });

  it("leaves a month in a trip's description and in date evidence, and lists the description instead", async () => {
    const may = await db.person.create({ data: { name: "May Smith", createdById: admin } });
    const trip = await db.trip.create({ data: { slug: "north", title: "North", description: "In May we drove north. May waved at every cow.", descriptionByHelper: true, startDate: new Date("2026-05-01"), endDate: new Date("2026-05-09"), createdById: admin } });
    const hers = await photo("m.jpg", { tripId: trip.id, estimatedDateNote: "2019–2020: May 2019 on the calendar", annotation: { ...annotation, title: "", caption: "May waves in May" } });
    await db.face.create({ data: { photoId: hers, personId: may.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await optOutPerson(may.id, form());
    // On her photograph the name is hers; the month is not.
    const p = await db.photo.findUniqueOrThrow({ where: { id: hers } });
    expect((p.annotation as StoredAnnotation).caption).toBe("A family member waves in May");
    expect(p.estimatedDateNote).toBe("2019–2020: May 2019 on the calendar");
    // A whole trip's description is left, and listed for somebody to edit.
    expect((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).description).toBe("In May we drove north. May waved at every cow.");
    const [left] = await db.forgetLeftover.findMany();
    expect((left.items as { trips: { id: string; fields: string[] }[] }).trips).toEqual([{ id: trip.id, fields: ["description"] }]);
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
    // Evidence for naming only: recognition still needs its own attestation.
    expect(after.adultConfirmedAt).not.toBeNull();
    expect(after.adultAttestedAt).toBeNull();
  });
});
