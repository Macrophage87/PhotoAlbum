import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", role: "ADMIN" as "ADMIN" | "MEMBER", queued: [] as { queue: string; data: unknown }[] }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: "X", role: who.role }),
  requireAdmin: async () => {
    if (who.role !== "ADMIN") throw new Error("Admins only");
    return { id: who.id, email: "x@example.com", name: "X", role: who.role };
  },
  requireAdminOrThrow: async () => {
    if (who.role !== "ADMIN") throw new Error("Admins only");
    return { id: who.id, email: "x@example.com", name: "X", role: who.role };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => undefined }) }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => void who.queued.push({ queue, data }) }));

import { setAlbumNameCheck } from "@/app/admin/actions";
import { setTripDescriptionShared, setTripNameCheck } from "@/app/trips/[slug]/actions";
import { setCollectionDescriptionShared } from "@/app/collections/actions";
import { setAnnotationShared, updateAnnotation } from "@/app/annotation/actions";
import { setNameInDescriptions } from "@/app/people/actions";
import { noteRelaxedDescription, noteRelaxedRelease } from "@/lib/annotation/relaxed-release";
import { NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { NAME_NOT_TO_BE_SHOWN, namesSomebodyRestricted, withoutWithdrawnNames } from "@/lib/people/forget";
import { nameCheckForContainer, nameCheckForPhoto, photoNameCheck, strictest } from "@/lib/people/name-check";
import { judgeDescription, judgeHelperText, placeFromMembersOnly } from "@/lib/annotation/members-only";
import { rejudgeNames, rejudgeSweep, rejudgeText, rejudgeTitles, type RejudgeJob } from "@/lib/annotation/rejudge";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { QUEUES } from "@/lib/jobs/queues";

const CHILD = { birthday: new Date("2019-05-01") };
const record = (caption: string, extra: Partial<StoredAnnotation> = {}): StoredAnnotation => ({ title: "", caption, description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "", ...extra });
const fd = (nameCheck: string) => {
  const f = new FormData();
  f.set("nameCheck", nameCheck);
  return f;
};
const rechecks = () => who.queued.filter((q) => q.queue === QUEUES.rejudgeText && (q.data as RejudgeJob).recheck).map((q) => (q.data as RejudgeJob).recheck);

describe("the name check setting", () => {
  let admin: string, member: string, tripId: string, otherTripId: string;
  const photo = (data: Record<string, unknown>) => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });
  const album = (nameCheck: "STRICT" | "RELAXED") => db.appSetting.upsert({ where: { id: "app" }, create: { id: "app", nameCheck }, update: { nameCheck } });

  beforeEach(async () => {
    await resetTestDb();
    who.queued = [];
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    member = (await db.user.create({ data: { email: "member@example.com", name: "Dana", role: "MEMBER" } })).id;
    who.id = admin;
    who.role = "ADMIN";
    tripId = (await db.trip.create({ data: { slug: "lake", title: "The lake", visibility: "PUBLIC", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: member } })).id;
    otherTripId = (await db.trip.create({ data: { slug: "coast", title: "The coast", visibility: "PUBLIC", startDate: new Date("2025-07-10"), endDate: new Date("2025-07-16"), createdById: admin } })).id;
    await db.person.create({ data: { name: "Summer Reyes", createdById: admin, ...CHILD } });
  });

  describe("the effective level", () => {
    it("takes the trip's own level, else the album's", async () => {
      const p = await photo({ tripId });
      const loose = await photo({});
      expect(await nameCheckForPhoto(p.id)).toBe("STRICT");
      await album("RELAXED");
      expect(await nameCheckForPhoto(p.id)).toBe("RELAXED");
      expect(await nameCheckForPhoto(loose.id)).toBe("RELAXED");
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "STRICT" } });
      expect(await nameCheckForPhoto(p.id)).toBe("STRICT");
      await album("STRICT");
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      expect(await nameCheckForPhoto(p.id)).toBe("RELAXED");
      expect(await nameCheckForPhoto(loose.id)).toBe("STRICT");
    });

    it("takes the strictest of the places strangers can see an item", async () => {
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      const p = await photo({ tripId });
      const collection = await db.collection.create({ data: { slug: "best", title: "Best", visibility: "PRIVATE", createdById: admin } });
      await db.collectionItem.create({ data: { collectionId: collection.id, photoId: p.id, addedById: admin } });
      // A private collection shows it to nobody new.
      expect(await nameCheckForPhoto(p.id)).toBe("RELAXED");
      for (const visibility of ["LINK", "PUBLIC"] as const) {
        await db.collection.update({ where: { id: collection.id }, data: { visibility } });
        expect(await nameCheckForPhoto(p.id)).toBe("STRICT");
      }
      // With the album relaxed as well, nowhere it is seen is strict.
      await album("RELAXED");
      expect(await nameCheckForPhoto(p.id)).toBe("RELAXED");
      expect(photoNameCheck({ trip: { nameCheck: "STRICT" }, collections: [{ collection: { visibility: "PUBLIC" } }] }, "RELAXED")).toBe("STRICT");
      expect(strictest([])).toBe("STRICT");
    });

    it("gives a trip's description and its activities the trip's level, and a collection the album's", async () => {
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      const activity = await db.activity.create({ data: { tripId, title: "Swim", startTime: new Date("2025-08-12T13:00:00Z"), endTime: new Date("2025-08-12T15:00:00Z") } });
      const collection = await db.collection.create({ data: { slug: "best", title: "Best", createdById: admin } });
      expect(await nameCheckForContainer("trip", tripId)).toBe("RELAXED");
      expect(await nameCheckForContainer("activity", activity.id)).toBe("RELAXED");
      expect(await nameCheckForContainer("collection", collection.id)).toBe("STRICT");
      expect(await nameCheckForContainer("trip", otherTripId)).toBe("STRICT");
    });
  });

  describe("who it is relaxed for", () => {
    const texts = ["Summer vacation at the lake."];

    it("relaxes the check for a child", async () => {
      expect(await namesSomebodyRestricted(texts)).toBe(true);
      expect(await namesSomebodyRestricted(texts, [], "RELAXED")).toBe(false);
    });

    it("keeps it strict for somebody who opted out, said no, or is waiting to be forgotten, child or not", async () => {
      await db.person.deleteMany();
      for (const data of [{ optedOutAt: new Date() }, { ...CHILD, optedOutAt: new Date() }, { ...CHILD, nameInDescriptions: false, nameInDescriptionsSetAt: new Date() }, { nameInDescriptions: false, nameInDescriptionsSetAt: new Date() }, { ...CHILD, forgetPendingAt: new Date() }]) {
        await db.person.deleteMany();
        await db.person.create({ data: { name: "Summer Reyes", createdById: admin, ...data } });
        expect([data, await namesSomebodyRestricted(texts, [], "RELAXED")]).toEqual([data, true]);
      }
      // A child whose naming a parent agreed to (which a child's naming cannot be) is restricted for being a child.
      await db.person.deleteMany();
      await db.person.create({ data: { name: "Summer Reyes", createdById: admin, ...CHILD, nameInDescriptions: true, nameInDescriptionsSetAt: new Date() } });
      expect(await namesSomebodyRestricted(texts, [], "RELAXED")).toBe(false);
    });

    it("keeps a withdrawn naming strict, on a relaxed trip too", async () => {
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      const annotation = record("Summer vacation at the lake.");
      const p = await photo({ tripId, annotation });
      // A child alone: relaxed there.
      expect((await withoutWithdrawnNames(p.id, { annotation, title: null })).hold).toBe(false);
      // Withdrawn, a child's too: strict, whatever the trip says.
      await db.person.updateMany({ data: { namingWithdrawnAt: new Date() } });
      expect((await withoutWithdrawnNames(p.id, { annotation, title: null })).hold).toBe(true);
      expect(await namesSomebodyRestricted(["Summer vacation at the lake."], [], "RELAXED")).toBe(true);
      await db.person.updateMany({ data: { namingWithdrawnAt: null, birthday: null } });
      await db.person.updateMany({ data: { namingWithdrawnAt: new Date() } });
      expect((await withoutWithdrawnNames(p.id, { annotation, title: null })).hold).toBe(true);
    });
  });

  describe("where it is used", () => {
    it("judges the helper's words at the item's level, the members-only rule's look at names included", async () => {
      const p = await photo({ tripId });
      for (const caption of ["Pictures from our summer vacation.", "Summer vacation at the lake.", "Crabbing in the summer, the lake at its best."]) {
        await db.trip.update({ where: { id: tripId }, data: { nameCheck: null } });
        expect([caption, (await judgeHelperText(p.id, record(caption), null)).membersOnly]).toEqual([caption, true]);
        await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
        expect([caption, (await judgeHelperText(p.id, record(caption), null)).membersOnly]).toEqual([caption, false]);
      }
      // Keywords as well, but for a lower-case word.
      expect((await judgeHelperText(p.id, record("A day at the lake.", { searchSummary: "Summer vacation, lake, swimming" }), null)).membersOnly).toBe(false);
      expect((await judgeHelperText(p.id, record("A day at the lake.", { tags: ["summer"] }), null)).membersOnly).toBe(true);
      // Never where the child is: tagged, or named in a way no excuse covers.
      expect((await judgeHelperText(p.id, record("Summer at the lake."), null)).membersOnly).toBe(true);
      expect((await judgeHelperText(p.id, record("A card from Summer."), null)).membersOnly).toBe(true);
      const child = await db.person.findFirstOrThrow();
      await db.face.create({ data: { photoId: p.id, personId: child.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
      expect((await judgeHelperText(p.id, record("Summer vacation at the lake."), null)).membersOnly).toBe(true);
    });

    it("leaves the members-only rule as it was for anybody but a child, and for a first name an adult shares", async () => {
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      const p = await photo({ tripId });
      const judge = async (caption: string) => (await judgeHelperText(p.id, record(caption), null)).membersOnly;
      // A child's surname that is a place: not a first name.
      await db.person.create({ data: { name: "Paris Jackson", createdById: admin, ...CHILD } });
      expect(await judge("Crepes in Paris.")).toBe(false);
      expect(await judge("Visiting Jackson.")).toBe(true);
      // An adult the album knows, restricted or not.
      await db.person.create({ data: { name: "Florence Jones", createdById: admin, birthday: new Date("1960-01-01"), nameInDescriptions: true, nameInDescriptionsSetAt: new Date() } });
      expect(await judge("The Duomo in Florence.")).toBe(true);
      await db.person.create({ data: { name: "Austin Price", createdById: admin, optedOutAt: new Date() } });
      expect(await judge("Driving to Austin.")).toBe(true);
      // A member of the album, or an adult, with the child's first name.
      expect(await judge("Summer vacation at the lake.")).toBe(false);
      await db.user.update({ where: { id: member }, data: { name: "Summer Hale" } });
      expect(await judge("Summer vacation at the lake.")).toBe(true);
    });

    it("does not flag again, when names are judged, what the relaxed check let out", async () => {
      await db.trip.update({ where: { id: otherTripId }, data: { nameCheck: "RELAXED" } });
      const relaxed = await photo({ tripId: otherTripId, annotation: record("Summer vacation at the lake."), placeEstimateName: "The lake", placeEstimateNote: "Swims in Summer sunshine", placeEstimateMembersOnly: false });
      const strict = await photo({ tripId, annotation: record("Summer vacation at the lake.") });
      await db.trip.update({ where: { id: otherTripId }, data: { description: "Summer vacation at the lake.", descriptionByHelper: true } });
      await db.trip.update({ where: { id: tripId }, data: { description: "Summer vacation at the lake.", descriptionByHelper: true } });
      await rejudgeNames();
      expect(await db.photo.findUniqueOrThrow({ where: { id: relaxed.id } })).toMatchObject({ annotationMembersOnly: false, placeEstimateMembersOnly: false });
      expect((await db.trip.findUniqueOrThrow({ where: { id: otherTripId } })).descriptionMembersOnly).toBe(false);
      expect((await db.photo.findUniqueOrThrow({ where: { id: strict.id } })).annotationMembersOnly).toBe(true);
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
    });

    it("judges a place guess and a description at their level", async () => {
      const p = await photo({ tripId });
      expect(await placeFromMembersOnly(p.id, { name: "The lake", evidence: "Swims in Summer sunshine" }, null)).toBe(true);
      expect(await judgeDescription("Summer vacation at the lake.", { names: [], notes: false })).toMatchObject({ membersOnly: true });
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      expect(await placeFromMembersOnly(p.id, { name: "The lake", evidence: "Swims in Summer sunshine" }, null)).toBe(false);
      expect(await judgeDescription("Summer vacation at the lake.", { names: [], notes: false, level: "RELAXED" })).toMatchObject({ membersOnly: false });
    });

    it("lets a member show the words to everyone only where the level allows it", async () => {
      const p = await photo({ tripId, annotation: record("Late June at the lake with Summer vacation."), annotationMembersOnly: true });
      const { annotationRevision } = await db.photo.findUniqueOrThrow({ where: { id: p.id } });
      await expect(setAnnotationShared(p.id, annotationRevision, true)).rejects.toThrow(NAME_NOT_TO_BE_SHOWN);
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      // "with Summer vacation": never after "with".
      await expect(setAnnotationShared(p.id, annotationRevision, true)).rejects.toThrow(NAME_NOT_TO_BE_SHOWN);
      await db.photo.update({ where: { id: p.id }, data: { annotation: record("Late June at the lake, summer vacation at last.") } });
      const { annotationRevision: next } = await db.photo.findUniqueOrThrow({ where: { id: p.id } });
      await setAnnotationShared(p.id, next, true);
      // Shown only because the relaxed check excused it: marked, to be judged again should that change.
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: false, relaxedReleaseAt: expect.any(Date) });
    });

    it("shows a trip's description by the trip's level, and a collection's by the album's", async () => {
      await db.trip.update({ where: { id: tripId }, data: { description: "Summer vacation at the lake.", descriptionByHelper: true, descriptionMembersOnly: true } });
      await expect(setTripDescriptionShared("lake", true)).rejects.toThrow(NAME_NOT_TO_BE_SHOWN);
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      await setTripDescriptionShared("lake", true);
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(false);
      await db.collection.create({ data: { slug: "best", title: "Best", description: "Summer vacation at the lake.", descriptionByHelper: true, descriptionMembersOnly: true, createdById: admin } });
      await expect(setCollectionDescriptionShared("best", true)).rejects.toThrow(NAME_NOT_TO_BE_SHOWN);
      await album("RELAXED");
      await setCollectionDescriptionShared("best", true);
    });
  });

  describe("who may change it", () => {
    it("lets only an admin change the album's, and records who and when", async () => {
      who.id = member;
      who.role = "MEMBER";
      await expect(setAlbumNameCheck(fd("RELAXED"))).rejects.toThrow("Admins only");
      expect((await db.appSetting.findUnique({ where: { id: "app" } }))?.nameCheck ?? "STRICT").toBe("STRICT");
      who.id = admin;
      who.role = "ADMIN";
      await setAlbumNameCheck(fd("RELAXED"));
      expect(await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).toMatchObject({ nameCheck: "RELAXED", nameCheckSetById: admin, nameCheckSetAt: expect.any(Date) });
      await expect(setAlbumNameCheck(fd("LOOSE"))).rejects.toThrow();
    });

    it("lets only whoever made the trip, or an admin, change a trip's", async () => {
      // Another member: not theirs to arrange.
      const other = (await db.user.create({ data: { email: "other@example.com", role: "MEMBER" } })).id;
      who.id = other;
      who.role = "MEMBER";
      await expect(setTripNameCheck("lake", fd("RELAXED"))).rejects.toThrow(NOT_YOUR_CONTAINER);
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).nameCheck).toBeNull();
      // Whoever made it.
      who.id = member;
      await setTripNameCheck("lake", fd("RELAXED"));
      expect(await db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ nameCheck: "RELAXED", nameCheckSetById: member });
      // An admin, back to the album's.
      who.id = admin;
      who.role = "ADMIN";
      await setTripNameCheck("lake", fd("INHERIT"));
      expect(await db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ nameCheck: null, nameCheckSetById: admin });
    });
  });

  describe("making it stricter", () => {
    const summer = "Summer vacation at the lake.";
    /** Words shown to everyone under the relaxed check, every way the album shows them, marked as the writes mark them. */
    const shownUnderRelaxed = async (trip: string) => {
      const shared = await photo({ tripId: trip, annotation: record(summer, { title: "Summer vacation" }), title: "Summer vacation", titleByHelper: true, annotationSharedAt: new Date() });
      const judged = await photo({ tripId: trip, annotation: record("Pictures from our summer vacation."), placeEstimateName: "The lake", placeEstimateNote: "Sunshine on the dock in the summer", placeEstimateMembersOnly: false });
      const plain = await photo({ tripId: trip, annotation: record("A sailboat on the lake.") });
      await db.trip.update({ where: { id: trip }, data: { description: summer, descriptionByHelper: true, descriptionSharedAt: new Date() } });
      const activity = await db.activity.create({ data: { tripId: trip, title: "Swim", description: summer, descriptionByHelper: true, startTime: new Date("2025-08-12T13:00:00Z"), endTime: new Date("2025-08-12T15:00:00Z") } });
      for (const p of [shared, judged, plain]) await noteRelaxedRelease(p.id);
      await noteRelaxedDescription("trip", trip);
      await noteRelaxedDescription("activity", activity.id);
      return { shared, judged, plain, activity };
    };
    const runQueued = async () => {
      for (const recheck of rechecks()) await rejudgeText({ recheck: recheck! });
    };

    it("marks only what needed a relaxed excuse", async () => {
      await album("RELAXED");
      const here = await shownUnderRelaxed(tripId);
      expect(await db.photo.findUniqueOrThrow({ where: { id: here.shared.id } })).toMatchObject({ relaxedReleaseAt: expect.any(Date) });
      expect(await db.photo.findUniqueOrThrow({ where: { id: here.judged.id } })).toMatchObject({ relaxedReleaseAt: expect.any(Date), placeRelaxedReleaseAt: expect.any(Date) });
      expect(await db.photo.findUniqueOrThrow({ where: { id: here.plain.id } })).toMatchObject({ relaxedReleaseAt: null, placeRelaxedReleaseAt: null });
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).relaxedReleaseAt).not.toBeNull();
      expect((await db.activity.findUniqueOrThrow({ where: { id: here.activity.id } })).relaxedReleaseAt).not.toBeNull();
    });

    it("checks again, album-wide, what the relaxed check let out, and takes back what the strict one holds", async () => {
      await album("RELAXED");
      const here = await shownUnderRelaxed(tripId);
      const collection = await db.collection.create({ data: { slug: "best", title: "Best", visibility: "PUBLIC", description: summer, descriptionByHelper: true, createdById: admin } });
      await noteRelaxedDescription("collection", collection.id);
      // A trip that says Relaxed itself stays as it is.
      await db.trip.update({ where: { id: otherTripId }, data: { nameCheck: "RELAXED" } });
      const kept = await photo({ tripId: otherTripId, annotation: record(summer), annotationSharedAt: new Date() });
      await noteRelaxedRelease(kept.id);

      await setAlbumNameCheck(fd("STRICT"));
      expect(rechecks()).toEqual([{}]);
      await runQueued();

      expect(await db.photo.findUniqueOrThrow({ where: { id: here.shared.id } })).toMatchObject({ annotationMembersOnly: true, annotationSharedAt: null, title: null, membersTitle: "Summer vacation", relaxedReleaseAt: null });
      expect(await db.photo.findUniqueOrThrow({ where: { id: here.judged.id } })).toMatchObject({ annotationMembersOnly: true, placeEstimateMembersOnly: true });
      expect((await db.photo.findUniqueOrThrow({ where: { id: here.plain.id } })).annotationMembersOnly).toBe(false);
      expect(await db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ descriptionMembersOnly: true, descriptionSharedAt: null });
      expect((await db.activity.findUniqueOrThrow({ where: { id: here.activity.id } })).descriptionMembersOnly).toBe(true);
      expect((await db.collection.findUniqueOrThrow({ where: { id: collection.id } })).descriptionMembersOnly).toBe(true);
      expect(await db.photo.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ annotationMembersOnly: false, annotationSharedAt: expect.any(Date), relaxedReleaseAt: expect.any(Date) });
    });

    it("checks again one trip made stricter, and nothing else", async () => {
      await db.trip.updateMany({ data: { nameCheck: "RELAXED" } });
      const here = await shownUnderRelaxed(tripId);
      const there = await photo({ tripId: otherTripId, annotation: record(summer), annotationSharedAt: new Date() });
      await noteRelaxedRelease(there.id);
      who.id = member;
      who.role = "MEMBER";
      await setTripNameCheck("lake", fd("STRICT"));
      expect(rechecks()).toEqual([{ tripId }]);
      await runQueued();
      expect((await db.photo.findUniqueOrThrow({ where: { id: here.shared.id } })).annotationMembersOnly).toBe(true);
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
      expect((await db.photo.findUniqueOrThrow({ where: { id: there.id } })).annotationMembersOnly).toBe(false);
    });

    it("is caught up by the nightly sweep when the job never ran", async () => {
      await album("RELAXED");
      const here = await shownUnderRelaxed(tripId);
      await album("STRICT");
      await rejudgeSweep();
      expect((await db.photo.findUniqueOrThrow({ where: { id: here.shared.id } })).annotationMembersOnly).toBe(true);
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
    });

    it("takes back what the strict members-only rule holds too: a month the strict matcher reads as a date", async () => {
      await db.person.deleteMany();
      await db.person.create({ data: { name: "May Reyes", createdById: admin, ...CHILD } });
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      const p = await photo({ tripId, annotation: record("A swim in May 2019.") });
      await noteRelaxedRelease(p.id);
      expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).relaxedReleaseAt).not.toBeNull();
      await setTripNameCheck("lake", fd("STRICT"));
      await runQueued();
      expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
    });

    it("takes back a relaxed trip's photograph that lost its trip and then joined a public collection", async () => {
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      const p = await photo({ tripId, annotation: record(summer), annotationSharedAt: new Date() });
      await noteRelaxedRelease(p.id);
      await db.photo.update({ where: { id: p.id }, data: { tripId: null } });
      await db.trip.delete({ where: { id: tripId } });
      await album("RELAXED");
      const collection = await db.collection.create({ data: { slug: "best", title: "Best", visibility: "PRIVATE", createdById: admin } });
      await db.collectionItem.create({ data: { collectionId: collection.id, photoId: p.id, addedById: admin } });
      await album("STRICT");
      await db.collection.update({ where: { id: collection.id }, data: { visibility: "PUBLIC" } });
      await rejudgeTitles({ collectionId: collection.id });
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, annotationSharedAt: null });
    });

    it("never touches what the strict check let out: words shared on a strict trip before their child was restricted", async () => {
      await db.person.deleteMany();
      await db.trip.update({ where: { id: otherTripId }, data: { nameCheck: "RELAXED" } });
      const p = await photo({ tripId, annotation: record("Rose at the lake."), annotationSharedAt: new Date() });
      await noteRelaxedRelease(p.id);
      await db.person.create({ data: { name: "Rose Reyes", createdById: admin, ...CHILD } });
      await rejudgeTitles({ tripId });
      await rejudgeTitles({ tripId: otherTripId });
      await rejudgeText({ recheck: {} });
      await rejudgeSweep();
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: false, annotationSharedAt: expect.any(Date), relaxedReleaseAt: null });
    });

    it("takes back what the relaxed check let out about a child whose naming is switched off, or who opts out", async () => {
      await db.person.deleteMany();
      const rose = await db.person.create({ data: { name: "Rose Reyes", createdById: admin, ...CHILD } });
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED", description: "A rose bush by the porch.", descriptionByHelper: true, descriptionMembersOnly: true } });
      const p = await photo({ tripId, annotation: record("Grandpa planted a rose bush."), annotationMembersOnly: true, placeEstimateName: "The lake", placeEstimateNote: "A rose garden by the dock", placeEstimateMembersOnly: false });
      const { annotationRevision } = await db.photo.findUniqueOrThrow({ where: { id: p.id } });
      await setAnnotationShared(p.id, annotationRevision, true);
      await setTripDescriptionShared("lake", true);
      await noteRelaxedRelease(p.id);
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: false, relaxedReleaseAt: expect.any(Date), placeRelaxedReleaseAt: expect.any(Date) });
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).relaxedReleaseAt).not.toBeNull();

      await setNameInDescriptions(rose.id, false);
      expect(rechecks()).toEqual([{}]);
      await runQueued();
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, annotationSharedAt: null, placeEstimateMembersOnly: true });
      expect(await db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ descriptionMembersOnly: true, descriptionSharedAt: null });

      // Opting out, the same (here caught by the nightly pass).
      await db.person.update({ where: { id: rose.id }, data: { nameInDescriptions: false, nameInDescriptionsSetAt: null } });
      const q = await photo({ tripId, annotation: record("Grandpa planted a rose bush."), annotationSharedAt: new Date() });
      await noteRelaxedRelease(q.id);
      await db.person.update({ where: { id: rose.id }, data: { optedOutAt: new Date() } });
      await rejudgeSweep();
      expect((await db.photo.findUniqueOrThrow({ where: { id: q.id } })).annotationMembersOnly).toBe(true);
    });

    it("marks what judging a new name keeps shown only by a relaxed excuse, so a stricter level takes it back", async () => {
      await db.person.deleteMany();
      await album("RELAXED");
      const p = await photo({ tripId, annotation: record(summer), placeEstimateName: "The lake", placeEstimateNote: "Summer sunshine on the dock", placeEstimateMembersOnly: false });
      await db.trip.update({ where: { id: tripId }, data: { description: summer, descriptionByHelper: true } });
      await noteRelaxedRelease(p.id);
      expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).relaxedReleaseAt).toBeNull();
      const child = await db.person.create({ data: { name: "Summer Reyes", createdById: admin, ...CHILD } });
      await rejudgeText({ people: [child.id] });
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: false, relaxedReleaseAt: expect.any(Date), placeEstimateMembersOnly: false, placeRelaxedReleaseAt: expect.any(Date) });
      expect(await db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ descriptionMembersOnly: false, relaxedReleaseAt: expect.any(Date) });
      await setAlbumNameCheck(fd("STRICT"));
      await runQueued();
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, placeEstimateMembersOnly: true });
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
    });

    it("clears the mark from words edited so they need no excuse", async () => {
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      const p = await photo({ tripId, annotation: record("Pictures from our summer vacation."), annotationSharedAt: new Date() });
      await noteRelaxedRelease(p.id);
      expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).relaxedReleaseAt).not.toBeNull();
      const f = new FormData();
      f.set("caption", "A sailboat on the lake.");
      await updateAnnotation(p.id, f);
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: false, relaxedReleaseAt: null });
    });

    it("takes back every marked item, however many, clearing marks as it goes", async () => {
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "RELAXED" } });
      const n = 450;
      await db.photo.createMany({ data: Array.from({ length: n }, (_, i) => ({ uploaderId: admin, originalName: `x${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const, tripId, annotation: record("Pictures from our summer vacation."), relaxedReleaseAt: new Date(), placeEstimateName: "The lake", placeEstimateNote: "Sunshine in the summer", placeEstimateMembersOnly: false, placeRelaxedReleaseAt: new Date() })) });
      await db.trip.update({ where: { id: tripId }, data: { nameCheck: "STRICT" } });
      const result = await rejudgeText({ recheck: { tripId } });
      expect(result).toMatchObject({ photos: n, places: n, missed: 0 });
      expect(await db.photo.count({ where: { tripId, OR: [{ annotationMembersOnly: false }, { placeEstimateMembersOnly: false }] } })).toBe(0);
    });

    it("lets nothing out when made relaxed: what is held stays held until it is judged or shown again", async () => {
      const held = await photo({ tripId, annotation: record(summer), annotationMembersOnly: true });
      await db.trip.update({ where: { id: tripId }, data: { description: summer, descriptionByHelper: true, descriptionMembersOnly: true } });
      await setAlbumNameCheck(fd("RELAXED"));
      expect(rechecks()).toEqual([]);
      await rejudgeSweep();
      await rejudgeTitles({ tripId });
      expect((await db.photo.findUniqueOrThrow({ where: { id: held.id } })).annotationMembersOnly).toBe(true);
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
    });
  });
});
