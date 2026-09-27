import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
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
import { setAnnotationShared, updateAnnotation } from "@/app/annotation/actions";
import { confirmPlaceEstimate } from "@/app/photos/[id]/actions";
import { updatePerson } from "@/app/people/actions";
import { tripTimeline } from "@/lib/timeline/queries";
import { NO_FILTER } from "@/lib/photos/filters";
import { rejudgeNames, rejudgeSweep, rejudgeText } from "@/lib/annotation/rejudge";
import { applyAnnotation } from "@/lib/annotation/apply";
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

  it("never takes a title a member typed before the album kept track, whoever it names", async () => {
    // As the members_only_text migration leaves a photograph from before it: notes, so members-only; the helper's
    // title moved aside; the member's own title, naming somebody the album knows, of unknown origin.
    await db.person.create({ data: { name: "Rose", createdById: who.id } });
    const helper = { title: "Helper title", caption: "The hut", description: "", tags: [], searchSummary: "" };
    const p = await photo({ context: "Rose's hut", title: "Rose at the hut", titleByHelper: null, membersTitle: "Helper title", annotationMembersOnly: true, annotation: helper });
    const titles = async () => db.photo.findUniqueOrThrow({ where: { id: p.id }, select: { title: true, membersTitle: true, titleByHelper: true } });
    // The worker's first sweep.
    await rejudgeSweep();
    expect(await titles()).toEqual({ title: "Rose at the hut", membersTitle: "Helper title", titleByHelper: null });
    // Described again: the helper's new title replaces its old one, and the member's stays.
    const again = annotationSchema.parse({ ...helper, title: "Hut in the snow", place: null, activity: null, objects: [], visibleText: null, season: "winter", mood: null, estimatedYear: null, estimatedPlace: null });
    await applyAnnotation(p.id, "m", again, {}, { sent: true });
    expect(await titles()).toEqual({ title: "Rose at the hut", membersTitle: "Hut in the snow", titleByHelper: null });
    // Shown to everyone and kept for the family again.
    const seen = (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationRevision;
    await setAnnotationShared(p.id, seen, true);
    await setAnnotationShared(p.id, seen, false);
    expect(await titles()).toEqual({ title: "Rose at the hut", membersTitle: "Hut in the snow", titleByHelper: null });
    await rejudgeNames(["Rose"]);
    expect((await titles()).title).toBe("Rose at the hut");
  });
});
