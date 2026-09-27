import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", role: "MEMBER" as "MEMBER" | "ADMIN" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "me@example.com", name: null, role: who.role }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
vi.mock("@/lib/google/account", () => ({ revokeRemovedConnection: async () => "none" }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { bulkFollowTime, bulkTakeOffActivity, putInActivity } from "@/app/photos/activity-actions";
import { removeMember } from "@/app/admin/actions";
import { fileExisting } from "@/lib/photos/file-existing";
import { bulkAssignActivity, bulkMoveToTrip, bulkSetDate } from "@/app/photos/bulk-actions";
import { deleteTrip } from "@/app/trips/[slug]/actions";
import { confirmEstimatedDate } from "@/app/annotation/actions";
import { createActivity, deleteActivity, updateActivity } from "@/app/trips/[slug]/activities/actions";
import { setPhotoDate, updatePhoto } from "@/app/photos/[id]/actions";
import { activityWindow, tripWindow } from "@/lib/photos/in-window";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { deleteActivityAndRefile, reassignPhotosForActivity, refileByClock } from "@/lib/activities/reassign";
import { keepSeconds } from "@/lib/activities/validation";

const at = (h: number, m = 0, s = 0) => new Date(Date.UTC(2025, 7, 12, h, m, s));

/** "Automation never overrides a hand-made choice": every way the album files by the clock, against one trip. */
describe("filing photographs on activities", () => {
  let me: string, cousin: string, tripId: string, walk: string;

  const photo = (takenAt: Date | null, over: Record<string, unknown> = {}) =>
    db.photo.create({
      data: { tripId, uploaderId: me, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt, takenAtSource: takenAt ? "EXIF_OFFSET" : null, tzOffsetMin: takenAt ? 0 : null, ...over },
      select: { id: true },
    });
  const row = (id: string) => db.photo.findUniqueOrThrow({ where: { id } });
  const form = (entries: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.append(k, v);
    return fd;
  };
  const redirected = (p: Promise<unknown>) => expect(p).rejects.toThrow(/REDIRECT/);

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "me@example.com", role: "MEMBER" } })).id;
    cousin = (await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } })).id;
    who.id = me;
    who.role = "MEMBER";
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me } })).id;
    walk = (await db.activity.create({ data: { tripId, title: "Morning walk", type: "HIKE", startTime: at(9), endTime: at(15) } })).id;
  });

  describe("taking a photograph off an activity (#61)", () => {
    it("stays off when the activity is saved again, after a drag to the loose strip", async () => {
      const p = await photo(at(14, 10), { activityId: walk });
      expect(await putInActivity(p.id, null)).toMatchObject({ ok: true });
      expect(await row(p.id)).toMatchObject({ activityId: null, activitySetById: me });
      // A typo fixed in the title: the hours are the same, and so is the member's answer.
      await redirected(updateActivity("acadia", walk, { status: "idle" }, form({ title: "Morning walk!", type: "HIKE", start: "2025-08-12T09:00", end: "2025-08-12T15:00" })));
      expect((await row(p.id)).activityId).toBeNull();
    });

    it("stays off after Take off activity from the selection bar, and after the album re-reads its date", async () => {
      const p = await photo(at(10), { activityId: walk });
      expect((await bulkTakeOffActivity([p.id])).n).toBe(1);
      await reassignPhotosForActivity(walk);
      expect((await row(p.id)).activityId).toBeNull();
      const now = await row(p.id);
      await applyPhotoInstant(now, at(11), 0, "MANUAL", me, { geotag: false });
      expect(await row(p.id)).toMatchObject({ activityId: null, activitySetById: me });
    });

    it("is recorded when None is picked on the photo's own page, and a plain save does not pin a clock filing", async () => {
      const p = await photo(at(10), { activityId: walk });
      await updatePhoto(p.id, form({ caption: "", context: "", tripId, activityId: "" }));
      expect(await row(p.id)).toMatchObject({ activityId: null, activitySetById: me });
      const clock = await photo(at(11), { activityId: walk });
      // The form shows a clock filing as Automatic, so that is what a plain save sends.
      await updatePhoto(clock.id, form({ caption: "Hi", context: "", tripId, activityId: "auto" }));
      expect(await row(clock.id)).toMatchObject({ activityId: walk, activitySetById: null });
    });

    it("means nothing once the photograph moves to another trip, which files it by its time", async () => {
      const p = await photo(at(10), { activityId: null, activitySetById: me });
      const other = (await db.trip.create({ data: { slug: "maine", title: "Maine", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me } })).id;
      const boat = (await db.activity.create({ data: { tripId: other, title: "Boat", type: "BOAT", startTime: at(9), endTime: at(11) } })).id;
      await updatePhoto(p.id, form({ caption: "", context: "", tripId: other }));
      expect(await row(p.id)).toMatchObject({ tripId: other, activityId: boat, activitySetById: null });
    });
  });

  describe("Assign activity from the trip gallery (#67)", () => {
    it("records the choice, so a change to the activity's hours does not undo it", async () => {
      const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(18), endTime: at(19) } })).id;
      const p = await photo(at(10), { activityId: walk });
      await bulkAssignActivity([p.id], boat);
      expect(await row(p.id)).toMatchObject({ activityId: boat, activitySetById: me });
      await db.activity.update({ where: { id: boat }, data: { startTime: at(18, 30) } });
      await reassignPhotosForActivity(boat);
      await reassignPhotosForActivity(walk);
      expect((await row(p.id)).activityId).toBe(boat);
    });

    it("records No activity as a choice too", async () => {
      const p = await photo(at(10), { activityId: walk });
      await bulkAssignActivity([p.id], null);
      expect(await row(p.id)).toMatchObject({ activityId: null, activitySetById: me });
      await reassignPhotosForActivity(walk);
      expect((await row(p.id)).activityId).toBeNull();
    });
  });

  describe("overlapping activities (#62)", () => {
    it("moves the clock's photographs to a shorter activity made later, and back when it is deleted", async () => {
      const inBoat = await photo(at(13, 30), { activityId: walk });
      const outside = await photo(at(10), { activityId: walk });
      const byHand = await photo(at(13, 40), { activityId: walk, activitySetById: me });
      await redirected(createActivity("acadia", { status: "idle" }, form({ title: "Boat tour", type: "BOAT", start: "2025-08-12T13:00", end: "2025-08-12T14:00" })));
      const boat = (await db.activity.findFirstOrThrow({ where: { title: "Boat tour" } })).id;
      expect((await row(inBoat.id)).activityId).toBe(boat);
      expect((await row(outside.id)).activityId).toBe(walk);
      // Put on the walk by a member: the clock does not move it to the boat.
      expect((await row(byHand.id)).activityId).toBe(walk);

      await redirected(deleteActivity("acadia", boat, form({})));
      expect(await row(inBoat.id)).toMatchObject({ activityId: walk, activitySetById: null });
    });

    it("sends what a shortened activity lets go to whatever else covers it, not to the loose strip", async () => {
      const lunch = (await db.activity.create({ data: { tripId, title: "Lunch", type: "OTHER", startTime: at(12), endTime: at(13) } })).id;
      const p = await photo(at(12, 30), { activityId: lunch });
      await redirected(updateActivity("acadia", lunch, { status: "idle" }, form({ title: "Lunch", type: "OTHER", start: "2025-08-12T12:45", end: "2025-08-12T13:00" })));
      expect((await row(p.id)).activityId).toBe(walk);
    });

    it("re-files a photograph hand-filed on a deleted activity by its time", async () => {
      const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(13), endTime: at(14) } })).id;
      const p = await photo(at(13, 30), { activityId: boat, activitySetById: me });
      await redirected(deleteActivity("acadia", boat, form({})));
      expect(await row(p.id)).toMatchObject({ activityId: walk, activitySetById: null });
    });
  });

  describe("editing an imported activity (#98)", () => {
    it("keeps the seconds of an end the form cannot show, and the photographs taken in them", async () => {
      const hike = (await db.activity.create({ data: { tripId, title: "Hike", type: "HIKE", startTime: at(16, 0, 12), endTime: at(17, 42, 37) } })).id;
      const summit = await photo(at(17, 42, 30), { activityId: hike });
      await redirected(updateActivity("acadia", hike, { status: "idle" }, form({ title: "Hike", type: "HIKE", start: "2025-08-12T16:00", end: "2025-08-12T17:42" })));
      const a = await db.activity.findUniqueOrThrow({ where: { id: hike } });
      expect([a.startTime.toISOString(), a.endTime.toISOString()]).toEqual([at(16, 0, 12).toISOString(), at(17, 42, 37).toISOString()]);
      expect((await row(summit.id)).activityId).toBe(hike);
    });

    it("takes the new time when the minute changed", () => {
      expect(keepSeconds(at(17, 43), at(17, 42, 37))).toEqual(at(17, 43));
      expect(keepSeconds(at(17, 42), at(17, 42, 37))).toEqual(at(17, 42, 37));
    });
  });

  describe("moving a selection to a trip (#102)", () => {
    it("files each on the activity its time falls in, held to who was on it", async () => {
      const loose = (takenAt: Date, uploaderId = me) => db.photo.create({ data: { uploaderId, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt, tzOffsetMin: 0 }, select: { id: true } });
      const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(13), endTime: at(14), participants: { connect: [{ id: cousin }] } } })).id;
      const mine = await loose(at(13, 30));
      const theirs = await loose(at(13, 30), cousin);
      const evening = await loose(at(20));
      who.role = "ADMIN";
      await bulkMoveToTrip([mine.id, theirs.id, evening.id], tripId);
      expect((await row(mine.id)).activityId).toBe(walk);
      expect((await row(theirs.id)).activityId).toBe(boat);
      expect((await row(evening.id)).activityId).toBeNull();
    });

    it("leaves a hand filing alone on a photograph that was already on the trip", async () => {
      const p = await photo(at(10), { activityId: null, activitySetById: me });
      await bulkMoveToTrip([p.id], tripId);
      expect(await row(p.id)).toMatchObject({ activityId: null, activitySetById: me });
    });
  });

  describe("date corrections (#63)", () => {
    it("file onto the uploader's own trip and outing, not another family's", async () => {
      const theirs = (await db.trip.create({ data: { slug: "theirs", title: "Theirs", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-20"), createdById: cousin, participants: { connect: [{ id: cousin }] } } })).id;
      await db.trip.update({ where: { id: tripId }, data: { participants: { connect: [{ id: me }] } } });
      const cousinsWalk = (await db.activity.create({ data: { tripId, title: "Cousins' walk", type: "HIKE", startTime: at(10), endTime: at(11), participants: { connect: [{ id: cousin }] } } })).id;
      const scan = await photo(null, { tripId: null });
      await applyPhotoInstant(await row(scan.id), at(10, 30), 0, "MANUAL", me, { geotag: false });
      const p = await row(scan.id);
      expect(p.tripId).toBe(tripId);
      expect(p.tripId).not.toBe(theirs);
      // The shorter outing covers the moment, but only the cousin was on it.
      expect(p.activityId).toBe(walk);
      expect(p.activityId).not.toBe(cousinsWalk);
    });
  });

  describe("Add all taken during it (#64)", () => {
    it("leaves out what a member filed on another activity or took off by hand, and counts them", async () => {
      const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(12), endTime: at(13) } })).id;
      const clock = await photo(at(12, 30), { activityId: boat });
      await photo(at(12, 40), { activityId: boat, activitySetById: me });
      await photo(at(12, 50), { activityId: null, activitySetById: me });
      const w = await db.activity.findUniqueOrThrow({ where: { id: walk } });
      const r = await activityWindow({ id: me, role: "MEMBER" }, w);
      expect(r.ids).toEqual([clock.id]);
      expect(r.elsewhere).toBe(2);
    });

    it("offers an admin only the photographs of the people the activity names", async () => {
      await db.activity.update({ where: { id: walk }, data: { participants: { connect: [{ id: me }] } } });
      const mine = await photo(at(10));
      await photo(at(10), { uploaderId: cousin });
      const w = await db.activity.findUniqueOrThrow({ where: { id: walk } });
      expect((await activityWindow({ id: cousin, role: "ADMIN" }, w)).ids).toEqual([mine.id]);
    });
  });

  describe("the way back from a hand choice (review)", () => {
    it("Automatic on the photo page forgets the choice and files it by its time", async () => {
      const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(18), endTime: at(19) } })).id;
      const p = await photo(at(10), { activityId: boat, activitySetById: me });
      await updatePhoto(p.id, form({ caption: "", context: "", tripId, activityId: "auto" }));
      expect(await row(p.id)).toMatchObject({ activityId: walk, activitySetById: null });
      const off = await photo(at(10), { activityId: null, activitySetById: me });
      await updatePhoto(off.id, form({ caption: "", context: "", tripId, activityId: "auto" }));
      expect(await row(off.id)).toMatchObject({ activityId: walk, activitySetById: null });
    });

    it("saving the page without touching Activity keeps whoever chose before", async () => {
      const p = await photo(at(10), { activityId: null, activitySetById: cousin });
      await updatePhoto(p.id, form({ caption: "Hi", context: "", tripId, activityId: "" }));
      expect(await row(p.id)).toMatchObject({ activityId: null, activitySetById: cousin });
      const q = await photo(at(10), { activityId: walk, activitySetById: cousin });
      await updatePhoto(q.id, form({ caption: "Hi", context: "", tripId, activityId: walk }));
      expect(await row(q.id)).toMatchObject({ activityId: walk, activitySetById: cousin });
    });

    it("Follow the time does the same for a whole selection", async () => {
      const a = await photo(at(10), { activityId: null, activitySetById: me });
      const b = await photo(at(20), { activityId: walk, activitySetById: me });
      expect((await bulkFollowTime([a.id, b.id])).n).toBe(2);
      expect(await row(a.id)).toMatchObject({ activityId: walk, activitySetById: null });
      expect(await row(b.id)).toMatchObject({ activityId: null, activitySetById: null });
    });

    it("a date a member gives by hand lets the time decide again for one kept off every activity", async () => {
      const p = await photo(at(20), { activityId: null, activitySetById: me });
      await applyPhotoInstant(await row(p.id), at(10), 0, "MANUAL", me, { geotag: false, releaseKeptOff: true });
      expect(await row(p.id)).toMatchObject({ activityId: walk, activitySetById: null });
      // A photo filed on an activity by hand keeps it, though.
      const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(18), endTime: at(19) } })).id;
      const q = await photo(at(18, 30), { activityId: boat, activitySetById: me });
      await applyPhotoInstant(await row(q.id), at(10), 0, "MANUAL", me, { geotag: false, releaseKeptOff: true });
      expect(await row(q.id)).toMatchObject({ activityId: boat, activitySetById: me });
    });

    it("moving to a trip where no activity covers it leaves it loose, with nobody's choice on it", async () => {
      const p = await photo(at(10), { activityId: walk, activitySetById: me });
      const other = (await db.trip.create({ data: { slug: "maine", title: "Maine", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me } })).id;
      await updatePhoto(p.id, form({ caption: "", context: "", tripId: other, activityId: walk }));
      expect(await row(p.id)).toMatchObject({ tripId: other, activityId: null, activitySetById: null });
    });
  });

  describe("more filing paths (review)", () => {
    it("fileExisting files a photo sent again to a trip by its time", async () => {
      const p = await db.photo.create({ data: { uploaderId: me, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: at(10), tzOffsetMin: 0 }, select: { id: true } });
      await fileExisting({ id: me, role: "MEMBER" }, p.id, { tripId });
      expect(await row(p.id)).toMatchObject({ tripId, activityId: walk, activitySetById: null });
    });

    it("tripWindow offers an admin only the photographs of the people the trip names", async () => {
      await db.trip.update({ where: { id: tripId }, data: { participants: { connect: [{ id: me }] } } });
      const loose = (uploaderId: string) => db.photo.create({ data: { uploaderId, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: at(10), tzOffsetMin: 0 }, select: { id: true } });
      const mine = await loose(me);
      await loose(cousin);
      const trip = await db.trip.findUniqueOrThrow({ where: { id: tripId } });
      expect((await tripWindow({ id: cousin, role: "ADMIN" }, trip)).ids).toEqual([mine.id]);
    });

    it("activityWindow falls back to the trip's people when the activity names nobody", async () => {
      await db.trip.update({ where: { id: tripId }, data: { participants: { connect: [{ id: me }] } } });
      const mine = await photo(at(10));
      await photo(at(10), { uploaderId: cousin });
      const w = await db.activity.findUniqueOrThrow({ where: { id: walk } });
      expect((await activityWindow({ id: cousin, role: "ADMIN" }, w)).ids).toEqual([mine.id]);
    });

    it("deleting the same activity twice at once is not an error, and files its photos once", async () => {
      const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(13), endTime: at(14) } })).id;
      const p = await photo(at(13, 30), { activityId: boat, activitySetById: me });
      await Promise.all([deleteActivityAndRefile(boat), deleteActivityAndRefile(boat)]);
      expect(await row(p.id)).toMatchObject({ activityId: walk, activitySetById: null });
    });

    it("refileByClock does not write over a photo whose date changed after it was read", async () => {
      const p = await photo(at(10), { activityId: null });
      const real = db.photo.findMany.bind(db.photo);
      const spy = vi.spyOn(db.photo, "findMany").mockImplementationOnce((async (args: Parameters<typeof real>[0]) => {
        const rows = await real(args);
        await db.photo.update({ where: { id: p.id }, data: { takenAt: at(20) } });
        return rows;
      }) as unknown as typeof db.photo.findMany);
      await refileByClock(tripId, { id: p.id });
      spy.mockRestore();
      expect((await row(p.id)).activityId).toBeNull();
    });
  });

  it("refileByClock reads again when an activity it chose is deleted before it writes", async () => {
    const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(9, 30), endTime: at(10, 30) } })).id;
    const p = await photo(at(10), { activityId: null });
    const real = db.activity.findMany.bind(db.activity);
    const spy = vi.spyOn(db.activity, "findMany").mockImplementationOnce((async (args: Parameters<typeof real>[0]) => {
      const rows = await real(args);
      await db.activity.delete({ where: { id: boat } });
      return rows;
    }) as unknown as typeof db.activity.findMany);
    await refileByClock(tripId, { id: p.id });
    spy.mockRestore();
    expect((await row(p.id)).activityId).toBe(walk);
  });

  describe("second review", () => {
    it("a plain save of Automatic leaves a filing nobody chose exactly where it is", async () => {
      // Put on the boat before the album kept count of who chose what; the clock would now say the walk.
      const boat = (await db.activity.create({ data: { tripId, title: "Boat", type: "BOAT", startTime: at(18), endTime: at(19) } })).id;
      const legacy = await photo(at(10), { activityId: boat, activitySetById: null });
      await updatePhoto(legacy.id, form({ caption: "Hi", context: "", tripId, activityId: "auto" }));
      expect(await row(legacy.id)).toMatchObject({ activityId: boat, activitySetById: null });
    });

    it("a bulk shift keeps a photo kept off every activity off, where typing its one date lets the time decide", async () => {
      const p = await photo(at(20), { activityId: null, activitySetById: me });
      // Ten hours earlier: inside the walk, but a shift is a correction of the clock, not a new answer.
      await bulkSetDate([p.id], { mode: "shift", years: 0, months: 0, days: 0, minutes: -600 });
      expect(await row(p.id)).toMatchObject({ activityId: null, activitySetById: me });
      await setPhotoDate(p.id, form({ takenAt: "2025-08-12T10:00" }));
      expect(await row(p.id)).toMatchObject({ activityId: walk, activitySetById: null });
    });

    it("deleting a trip leaves its photos with no activity and nobody's choice", async () => {
      const p = await photo(at(10), { activityId: null, activitySetById: me });
      const q = await photo(at(10), { activityId: walk, activitySetById: me });
      who.role = "ADMIN";
      await expect(deleteTrip("acadia")).rejects.toThrow(/REDIRECT/);
      expect(await row(p.id)).toMatchObject({ tripId: null, activityId: null, activitySetById: null });
      expect(await row(q.id)).toMatchObject({ tripId: null, activityId: null, activitySetById: null });
    });

    it("confirming an estimated date puts the photo on the day's trip, but its made-up noon picks no activity", async () => {
      const scan = await photo(null, { tripId: null, lat: 1, lng: 2, gpsSource: "TRACK" });
      await confirmEstimatedDate(scan.id, form({ date: "2025-08-12" }));
      // Noon is inside the walk, but only the day is known.
      expect(await row(scan.id)).toMatchObject({ tripId, activityId: null, activitySetById: null, takenAtSource: "MANUAL", dateSetById: me, estimatedDateSource: "MEMBER", lat: null, gpsSource: null });
      const off = await photo(null, { activityId: null, activitySetById: me });
      await confirmEstimatedDate(off.id, form({ date: "2025-08-12" }));
      expect(await row(off.id)).toMatchObject({ activityId: null, activitySetById: me });
    });
  });

  describe("upgrading an album made before 'kept off by hand' existed", () => {
    it("forgets the setter left on photos with no activity, which never meant 'kept off'", async () => {
      const stale = await photo(at(10), { activityId: null, activitySetById: me });
      const tripless = await photo(at(10), { tripId: null, activityId: null, activitySetById: me });
      const chosen = await photo(at(10), { activityId: walk, activitySetById: me });
      const dir = path.join(process.cwd(), "prisma/migrations/20260926150100_forget_stale_activity_setter/migration.sql");
      await db.$executeRawUnsafe(readFileSync(dir, "utf8"));
      expect((await row(stale.id)).activitySetById).toBeNull();
      expect((await row(tripless.id)).activitySetById).toBeNull();
      expect((await row(chosen.id)).activitySetById).toBe(me);
    });
  });

  describe("removing a member", () => {
    it("hands their choices to the admin rather than emptying them", async () => {
      const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
      const p = await photo(at(10), { uploaderId: cousin, activityId: null, activitySetById: cousin, placeSetById: cousin, dateSetById: cousin, takenAtSource: "MANUAL" });
      who.id = admin;
      who.role = "ADMIN";
      await removeMember(cousin);
      expect(await row(p.id)).toMatchObject({ uploaderId: admin, activityId: null, activitySetById: admin, placeSetById: admin, dateSetById: admin });
    });
  });
});
