import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", reply: "", queued: [] as { queue: string; data: unknown }[] }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "dana@example.com", name: "Dana", role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => void who.queued.push({ queue, data }) }));
vi.mock("@/lib/annotation/eligibility", async (original) => ({ ...(await original<typeof import("@/lib/annotation/eligibility")>()), annotationGates: async () => ({ active: true, model: "m" }) }));
vi.mock("@/lib/annotation/client", async (original) => ({
  ...(await original<typeof import("@/lib/annotation/client")>()),
  anthropic: () => ({ messages: { create: async () => ({ model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify({ description: who.reply }) }] }) } }),
}));

import { writeContainerDescription } from "@/lib/annotation/container";
import { describeActivityWithAi, setActivityDescription } from "@/app/trips/[slug]/activities/actions";
import { setTripDescription, setTripDescriptionShared } from "@/app/trips/[slug]/actions";
import { setActivityDescriptionShared } from "@/app/trips/[slug]/activities/actions";
import { setCollectionDescriptionShared } from "@/app/collections/actions";
import { setAnnotationShared, updateAnnotation } from "@/app/annotation/actions";
import { confirmPlaceEstimate } from "@/app/photos/[id]/actions";
import { updatePerson } from "@/app/people/actions";
import { tripTimeline } from "@/lib/timeline/queries";
import { NO_FILTER } from "@/lib/photos/filters";
import { rejudgeNames, rejudgeSweep, rejudgeText } from "@/lib/annotation/rejudge";
import { applyAnnotation } from "@/lib/annotation/apply";
import { scrubWithdrawnNames } from "@/lib/people/forget";
import { annotationSchema } from "@/lib/annotation/schema";

/**
 * A trip's, a collection's or an activity's description, when the helper wrote it or a member typed it: members-only
 * when it came from names, notes, a members-only description or a private trip's title, or names somebody; and once
 * members-only, public again only when a member says so.
 */
describe("descriptions that stay in the family", () => {
  let tripId: string, activityId: string;
  const photo = (data: Record<string, unknown>) => db.photo.create({ data: { uploaderId: who.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });

  beforeEach(async () => {
    await resetTestDb();
    who.id = (await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", visibility: "PUBLIC", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: who.id } })).id;
    activityId = (await db.activity.create({ data: { tripId, title: "Ocean Path", startTime: new Date("2025-08-12T13:00:00Z"), endTime: new Date("2025-08-12T15:00:00Z") } })).id;
    await photo({ tripId, activityId, takenAt: new Date("2025-08-12T14:00:00Z") });
  });

  it("keeps the helper's trip description public when it was written from nothing private", async () => {
    who.reply = "Fog, cliffs and a lot of walking.";
    await writeContainerDescription("trip", tripId);
    expect(await db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ description: who.reply, descriptionMembersOnly: false });
  });

  it("keeps it for the family when the photographs it was shown carry notes", async () => {
    await db.photo.updateMany({ where: { tripId }, data: { context: "the key is under the mat" } });
    who.reply = "Fog, cliffs and a lot of walking.";
    await writeContainerDescription("trip", tripId);
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
  });

  it("keeps a description written again from a members-only one for the family", async () => {
    await db.trip.update({ where: { id: tripId }, data: { description: "A week with Nana.", descriptionMembersOnly: true } });
    who.reply = "A week on the coast.";
    await writeContainerDescription("trip", tripId);
    expect(await db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ description: "A week on the coast.", descriptionMembersOnly: true });
  });

  it("keeps an activity's description for the family when it repeats its private trip's title", async () => {
    await db.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE", title: "Hopkins weekend" } });
    who.reply = "A slow walk from Hopkins to the harbor.";
    await describeActivityWithAi("acadia", activityId);
    expect((await db.activity.findUniqueOrThrow({ where: { id: activityId } })).descriptionMembersOnly).toBe(true);
    who.reply = "A slow walk to the harbor.";
    await db.activity.update({ where: { id: activityId }, data: { description: null, descriptionMembersOnly: false } });
    await describeActivityWithAi("acadia", activityId);
    expect((await db.activity.findUniqueOrThrow({ where: { id: activityId } })).descriptionMembersOnly).toBe(false);
  });

  it("keeps a members-only description members-only through any hand edit, until a member shows it to everyone", async () => {
    await db.trip.update({ where: { id: tripId }, data: { description: "A week with Nana.\nAnd the dog.", descriptionMembersOnly: true } });
    // A textarea sends its lines back with CRLF, and a rewrite is still the same description's.
    await setTripDescription("acadia", "A week with Nana.\r\nAnd the dog.");
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
    await setTripDescription("acadia", "A week on the coast.");
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
    await setTripDescriptionShared("acadia", true);
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(false);
    await setTripDescriptionShared("acadia", false);
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(true);
  });

  it("keeps a description a member showed to everyone shown while its words are the same, even when a name arrives", async () => {
    await db.trip.update({ where: { id: tripId }, data: { description: "A week with Nana.\nAnd the dog.", descriptionMembersOnly: true } });
    await setTripDescriptionShared("acadia", true);
    await setTripDescription("acadia", "A week with Nana.\r\nAnd the dog.");
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(false);
    await db.person.create({ data: { name: "Nana", createdById: who.id } });
    await rejudgeNames(["Nana"]);
    expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(false);
    // New words are judged afresh.
    await setTripDescription("acadia", "A week with Nana and the dog.");
    expect(await db.trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({ descriptionMembersOnly: true, descriptionSharedAt: null });
  });

  it("starts a hand-written description that names somebody members-only", async () => {
    await setActivityDescription("acadia", activityId, "Dana led the way.");
    expect((await db.activity.findUniqueOrThrow({ where: { id: activityId } })).descriptionMembersOnly).toBe(true);
    await db.activity.update({ where: { id: activityId }, data: { descriptionMembersOnly: false } });
    await setActivityDescription("acadia", activityId, "A steady walk.");
    expect((await db.activity.findUniqueOrThrow({ where: { id: activityId } })).descriptionMembersOnly).toBe(false);
  });

  it("reads a members-only activity description on a trip's timeline to members only", async () => {
    await db.activity.update({ where: { id: activityId }, data: { description: "Dana led the way.", descriptionMembersOnly: true } });
    const stranger = await tripTimeline(tripId, "UTC", NO_FILTER);
    expect(JSON.stringify(stranger.groups)).not.toContain("Dana led the way");
    expect(JSON.stringify(stranger.groups)).toContain("Ocean Path");
    const family = await tripTimeline(tripId, "UTC", { ...NO_FILTER, member: true });
    expect(JSON.stringify(family.groups)).toContain("Dana led the way");
  });

  it("keeps a member's edit of the helper's text members-only once it names somebody, and never makes it public again", async () => {
    const p = await photo({ annotation: { title: "Boat day", caption: "On the boat", description: "A day on the boat.", tags: [], searchSummary: "", season: "summer", objects: [] } });
    const fd = (description: string) => { const f = new FormData(); f.set("caption", "On the boat"); f.set("description", description); return f; };
    await updateAnnotation(p.id, fd("Dana steering the boat."));
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
    await updateAnnotation(p.id, fd("A day on the boat."));
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
  });

  it("lets the uploader show the helper's description and title to everyone, and take it back", async () => {
    const p = await photo({ context: "Nana's boat", annotation: { title: "Nana on the boat", caption: "On the boat", description: "Nana steers.", tags: [], searchSummary: "" }, annotationMembersOnly: true, membersTitle: "Nana on the boat" });
    const opened = (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationRevision;
    // Somebody edits the words after the page was opened: the page's click is refused, and nothing is shown.
    const fd = new FormData();
    fd.set("caption", "On the boat");
    fd.set("description", "Nana steers, and Ben waves.");
    await updateAnnotation(p.id, fd);
    await expect(setAnnotationShared(p.id, opened, true)).rejects.toThrow(/description changed/);
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
    const seen = (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationRevision;
    expect(seen).toBe(opened + 1);
    await setAnnotationShared(p.id, seen, true);
    const shown = await db.photo.findUniqueOrThrow({ where: { id: p.id } });
    expect(shown).toMatchObject({ annotationMembersOnly: false, title: "Nana on the boat", membersTitle: null });
    expect(shown.annotationSharedAt).not.toBeNull();
    await setAnnotationShared(p.id, seen, false);
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, title: null, membersTitle: "Nana on the boat", annotationSharedAt: null });
    // Somebody else's photograph is not theirs to publish.
    const other = await db.user.create({ data: { email: "o@example.com" } });
    const theirs = await db.photo.create({ data: { uploaderId: other.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotationMembersOnly: true } });
    await expect(setAnnotationShared(theirs.id, 0, true)).rejects.toThrow();
  });

  it("accepts a guessed place without publishing a name that is the family's", async () => {
    const guess = { lat: 39.4, lng: -76.6, gpsSource: "ESTIMATE" as const, placeEstimateName: "Towson, Maryland", placeEstimateNote: "the notes say Nana's", placeEstimateConfidence: 0.8 };
    const family = await photo({ ...guess, placeEstimateMembersOnly: true });
    const res = await confirmPlaceEstimate(family.id);
    expect(res).toMatchObject({ ok: true, placeName: null });
    expect(await db.photo.findUniqueOrThrow({ where: { id: family.id } })).toMatchObject({ gpsSource: "MANUAL", placeName: null, lat: 39.4 });
    const anyone = await photo({ ...guess, placeEstimateMembersOnly: false });
    expect(await confirmPlaceEstimate(anyone.id)).toMatchObject({ ok: true, placeName: "Towson, Maryland" });
  });

  it("queues the judging of a new name instead of doing it in the request", async () => {
    const pet = await db.person.create({ data: { name: "Rex", kind: "HUMAN", createdById: who.id } });
    const p = await photo({ annotation: { title: "Biscuit asleep", caption: "Biscuit asleep", description: "", tags: [], searchSummary: "" } });
    const old = await photo({ annotation: { title: "Rex asleep", caption: "Rex asleep", description: "", tags: [], searchSummary: "" } });
    who.queued.length = 0;
    const fd = new FormData();
    fd.set("name", "Biscuit");
    await updatePerson(pet.id, fd);
    // Who, never the name: a queued job outlives the request.
    expect(who.queued).toEqual([{ queue: "rejudge-text", data: { people: [pet.id] } }]);
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(false);
    // The old name too, read when it runs: what was written with it is still about them.
    expect((await rejudgeText(who.queued[0].data as never)).photos).toBe(2);
    expect((await db.photo.findUniqueOrThrow({ where: { id: old.id } })).annotationMembersOnly).toBe(true);
  });

  it("keeps a title a member typed before the album kept track for members when it names somebody, and never erases it", async () => {
    // A photograph from before the members_only_text migration: notes, the helper's title in its record, and the
    // member's own title naming somebody the album knows. The migration's own pass then runs over it.
    await db.person.create({ data: { name: "Rose", createdById: who.id } });
    const helper = { title: "Helper title", caption: "The hut", description: "", tags: [], searchSummary: "" };
    const p = await photo({ context: "Rose's hut", title: "Rose at the hut", annotation: helper });
    const migration = readFileSync(path.join(process.cwd(), "prisma/migrations/20260926120100_members_only_text/migration.sql"), "utf8");
    await db.$executeRawUnsafe(migration.match(/^DO \$\$[\s\S]*?^END \$\$;/m)![0]);
    const titles = async () => db.photo.findUniqueOrThrow({ where: { id: p.id }, select: { title: true, membersTitle: true, titleByHelper: true } });
    // Members-only, the helper's title moved aside, the member's of unknown origin.
    expect(await titles()).toEqual({ title: "Rose at the hut", membersTitle: "Helper title", titleByHelper: null });
    // The worker's first sweep: nothing proves it is the helper's, and it names Rose. It is what members read now;
    // the helper's title is still in its record.
    await rejudgeSweep();
    expect(await titles()).toEqual({ title: null, membersTitle: "Rose at the hut", titleByHelper: null });
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation).toMatchObject({ title: "Helper title" });
    // Described again: the helper's new title does not replace the member's.
    const again = annotationSchema.parse({ ...helper, title: "Hut in the snow", place: null, activity: null, objects: [], visibleText: null, season: "winter", mood: null, estimatedYear: null, estimatedPlace: null });
    await applyAnnotation(p.id, "m", again, {}, { sent: true });
    expect(await titles()).toEqual({ title: null, membersTitle: "Rose at the hut", titleByHelper: null });
    // Shown to everyone and kept for the family again.
    const seen = (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationRevision;
    await setAnnotationShared(p.id, seen, true);
    await setAnnotationShared(p.id, seen, false);
    expect(await titles()).toEqual({ title: null, membersTitle: "Rose at the hut", titleByHelper: null });
    await rejudgeNames(["Rose"]);
    expect((await titles()).membersTitle).toBe("Rose at the hut");
  });

  it("never puts back a title a member typed while an answer was being stored", async () => {
    const p = await photo({});
    const answer = annotationSchema.parse({ title: "Mail boat lunch", caption: "Lobster rolls", description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "", estimatedYear: null, estimatedPlace: null });
    // The member saves a title of their own after the answer read the row, before it is written.
    const real = db.photo.findUnique.bind(db.photo);
    const spy = vi.spyOn(db.photo, "findUnique").mockImplementationOnce((async (args: never) => {
      const read = await real(args);
      await db.photo.update({ where: { id: p.id }, data: { title: "Our boat day", titleByHelper: false } });
      return read;
    }) as never);
    who.queued.length = 0;
    await applyAnnotation(p.id, "m", answer, {});
    spy.mockRestore();
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ title: "Our boat day", titleByHelper: false, annotation: null, annotationError: "text_changed" });
    // Asked again, against the title as it is now.
    expect(who.queued.map((q) => q.queue)).toContain("annotate-photo");
    await applyAnnotation(p.id, "m", answer, {});
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ title: "Our boat day", titleByHelper: false, membersTitle: null });
  });

  describe("showing words to everyone that may name somebody the album may not name", () => {
    const helperRecord = (title: string, description = "") => ({ title, caption: "", description, tags: [], searchSummary: "" });
    const heldPhoto = (title: string, description = "") => photo({ annotation: helperRecord(title, description), annotationMembersOnly: true, membersTitle: title });
    const share = async (id: string) => setAnnotationShared(id, (await db.photo.findUniqueOrThrow({ where: { id } })).annotationRevision, true);

    it("G1: refuses once a withdrawal's fortnight has passed, for an everyday name and one only the neighbour rule excuses", async () => {
      // As in real data: named once without evidence of being an adult, and the naming withdrawn.
      const withdrawn = { nameInDescriptions: false, nameInDescriptionsSetAt: new Date("2026-01-01"), namingWithdrawnAt: new Date(Date.now() - 30 * 86_400_000), createdById: who.id };
      await db.person.create({ data: { name: "Rose", ...withdrawn } });
      await db.person.create({ data: { name: "Ximena", ...withdrawn } });
      // Withdrawn by the migration from an old "named" flag, with no record of when naming was decided.
      await db.person.create({ data: { name: "Ivy", nameInDescriptions: true, namingWithdrawnAt: new Date(Date.now() - 30 * 86_400_000), createdById: who.id } });
      const rose = await heldPhoto("Rose At The Hut");
      const ximena = await heldPhoto("Ximena Hut Walk", "Ximena Hut Walk, in the snow.");
      const ivy = await heldPhoto("Ivy At The Hut");
      await scrubWithdrawnNames();
      expect(await db.person.count({ where: { namingWithdrawnAt: { not: null } } })).toBe(0);
      // Taken back for good is recorded as a naming decided and not allowed.
      expect(await db.person.count({ where: { nameInDescriptionsSetAt: null } })).toBe(0);
      for (const p of [rose, ximena, ivy]) await expect(share(p.id)).rejects.toThrow(/isn't to be shown outside the family/);
      expect(await db.photo.count({ where: { annotationMembersOnly: false } })).toBe(1);
    });

    it("G2: refuses when an admin has switched naming off, for photographs, trips, collections and activities", async () => {
      const ximena = await db.person.create({ data: { name: "Ximena", nameInDescriptions: true, adultAttestedAt: new Date(), createdById: who.id } });
      const p = await heldPhoto("Ximena Hut Walk");
      await db.trip.update({ where: { id: tripId }, data: { description: "Ximena Hut Walk, in the snow.", descriptionByHelper: true, descriptionMembersOnly: true } });
      const collection = await db.collection.create({ data: { slug: "snow", title: "Snow", description: "Ximena in the snow.", descriptionByHelper: true, descriptionMembersOnly: true, createdById: who.id } });
      await db.activity.update({ where: { id: activityId }, data: { description: "Ximena leads the walk.", descriptionByHelper: true, descriptionMembersOnly: true } });
      // Agreed to be named: shown as asked.
      await share(p.id);
      expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(false);
      await db.person.update({ where: { id: ximena.id }, data: { nameInDescriptions: false, nameInDescriptionsSetAt: new Date() } });
      const q = await heldPhoto("Ximena Hut Walk");
      await expect(share(q.id)).rejects.toThrow(/isn't to be shown outside the family/);
      await expect(setTripDescriptionShared("acadia", true)).rejects.toThrow(/isn't to be shown outside the family/);
      await expect(setCollectionDescriptionShared("snow", true)).rejects.toThrow(/isn't to be shown outside the family/);
      await expect(setActivityDescriptionShared("acadia", activityId, true)).rejects.toThrow(/isn't to be shown outside the family/);
      expect((await db.collection.findUniqueOrThrow({ where: { id: collection.id } })).descriptionMembersOnly).toBe(true);
    });

    it("still shows words that name nobody the album may not name", async () => {
      await db.person.create({ data: { name: "Rose", nameInDescriptionsSetAt: new Date("2026-01-01"), namingWithdrawnAt: new Date(Date.now() - 30 * 86_400_000), createdById: who.id } });
      const p = await heldPhoto("a rose by the hut", "The hut in winter.");
      await share(p.id);
      expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(false);
      await db.trip.update({ where: { id: tripId }, data: { description: "Fog and cliffs.", descriptionMembersOnly: true } });
      await setTripDescriptionShared("acadia", true);
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(false);
    });

    /** The reviewer's people, each tagged nowhere, named in the helper's words and in a member's. */
    const PEOPLE: [string, string, Record<string, unknown>, boolean][] = [
      ["P1 never asked", "Pia", {}, true],
      ["P2 attested adult, never asked", "Paz", { adultAttestedAt: new Date() }, true],
      ["P3 recognized adult, never asked about naming", "Pim", { faceIndexing: true, birthday: new Date("1970-01-01") }, true],
      ["P4 adult by birthday, never asked", "Pola", { birthday: new Date("1970-01-01") }, true],
      ["P5 naming switched off by an admin", "Peri", { birthday: new Date("1970-01-01"), nameInDescriptions: false, nameInDescriptionsSetAt: new Date() }, false],
      ["P6 opted out", "Pru", { optedOutAt: new Date() }, false],
      ["P7 a child by birthday", "Pip", { birthday: new Date("2019-01-01") }, false],
    ];
    it.each(PEOPLE)("%s: the helper's words share only when the album may name them; a member's always do", async (_, name, data, shares) => {
      await db.person.create({ data: { name, createdById: who.id, ...data } });
      const p = await heldPhoto(`${name} At The Hut`, `${name} walks to the hut.`);
      if (shares) await share(p.id);
      else await expect(share(p.id)).rejects.toThrow(/isn't to be shown outside the family/);
      await db.trip.update({ where: { id: tripId }, data: { description: `${name} walks to the hut.`, descriptionByHelper: true, descriptionMembersOnly: true } });
      if (shares) await setTripDescriptionShared("acadia", true);
      else await expect(setTripDescriptionShared("acadia", true)).rejects.toThrow(/isn't to be shown outside the family/);
      // Written by a member: theirs to show, as a caption is.
      await db.trip.update({ where: { id: tripId }, data: { description: `${name} walks to the hut.`, descriptionByHelper: false, descriptionMembersOnly: true } });
      await setTripDescriptionShared("acadia", true);
      expect((await db.trip.findUniqueOrThrow({ where: { id: tripId } })).descriptionMembersOnly).toBe(false);
    });

    it("shares everyday words, dates and a surname alone, whoever may not be named", async () => {
      const off = { nameInDescriptions: false, nameInDescriptionsSetAt: new Date(), createdById: who.id };
      await db.person.create({ data: { name: "May Smith", ...off } });
      await db.person.create({ data: { name: "Grace Lee", createdById: who.id } });
      await db.person.create({ data: { name: "Ruth Baker", ...off } });
      for (const words of ["Lake day in May.", "Grace before the big dinner.", "The Baker Street bakery"]) {
        const p = await heldPhoto(words, words);
        await share(p.id);
        expect([words, (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly]).toEqual([words, false]);
      }
    });

    it("keeps a title of unknown origin that may name her for members, even one already shown to everyone", async () => {
      await db.person.create({ data: { name: "Rose", namingWithdrawnAt: new Date(), createdById: who.id } });
      const p = await photo({ title: "Rose At The Hut", titleByHelper: null, annotation: helperRecord("The hut"), annotatedAt: new Date(), annotationSharedAt: new Date() });
      await scrubWithdrawnNames();
      expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ title: null, membersTitle: "Rose At The Hut" });
    });
  });
});
