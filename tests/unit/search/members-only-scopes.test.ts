import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { searchMedia } from "@/lib/search/query";
import { idsMatching } from "@/lib/photos/page";
import { applyAnnotation } from "@/lib/annotation/apply";
import { applyPlaceEstimate } from "@/lib/annotation/place";
import { annotationSchema } from "@/lib/annotation/schema";
import { writtenFromMembersOnly } from "@/lib/annotation/members-only";
import { flagPhoto, MATCHER_VERSION, rejudgeNames, rejudgeSweep, rejudgeText, rejudgeTitles } from "@/lib/annotation/rejudge";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
const record = (over: Record<string, unknown> = {}) =>
  annotationSchema.parse({ title: "Mail boat lunch", caption: "Lobster rolls on the mail boat", description: "Lunch on the deck.", tags: ["boat"], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "boat lunch", estimatedYear: null, estimatedPlace: null, ...over });

describe("what strangers may search, container by container, and the words' scope", () => {
  let dana: string, member: Viewer;
  const photo = (data: Record<string, unknown>) => db.photo.create({ data: { uploaderId: dana, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });

  beforeEach(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } });
    dana = u.id;
    member = { kind: "user", user: { id: dana, email: u.email, name: u.name, role: "MEMBER" }, shareTokens: new Map() };
  });

  it("lets strangers search by a public collection's title only, and moves a title between columns as the collection changes", async () => {
    const trip = await db.trip.create({ data: { slug: "t", title: "Coast", visibility: "PUBLIC", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id, caption: "Rocks" });
    const secret = await db.collection.create({ data: { slug: "s", title: "Hospital visits", createdById: dana } });
    await db.collectionItem.create({ data: { collectionId: secret.id, photoId: p.id, addedById: dana } });
    expect(await searchMedia(anon, { q: "hospital" }, 120, null)).toEqual([]);
    expect((await searchMedia(member, { q: "hospital" }, 120, null)).map((h) => h.id)).toEqual([p.id]);
    await db.collection.update({ where: { id: secret.id }, data: { visibility: "PUBLIC" } });
    expect((await searchMedia(anon, { q: "hospital" }, 120, null)).map((h) => h.id)).toEqual([p.id]);
    await db.collection.update({ where: { id: secret.id }, data: { visibility: "LINK", shareToken: "tok" } });
    expect(await searchMedia(anon, { q: "hospital" }, 120, null)).toEqual([]);
  });

  it("gives a stranger's hit no title where the only one is the helper's members-only title, and members find it by that title", async () => {
    const trip = await db.trip.create({ data: { slug: "t", title: "Coast", visibility: "PUBLIC", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id, caption: "Rocks at dusk", context: "Nana's favorite spot" });
    await applyAnnotation(p.id, "m", record({ title: "Nana's lookout", caption: "The lookout" }), {});
    const [hit] = await searchMedia(anon, { q: "rocks" }, 120, null);
    expect(hit.title).toBeNull();
    // "lookout" is only in the members-only title (and the helper's members-only caption).
    expect(await searchMedia(anon, { q: "lookout" }, 120, null)).toEqual([]);
    expect((await searchMedia(member, { q: "lookout" }, 120, null))[0].title).toBe("Nana's lookout");
    expect(await idsMatching("lookou", { member: true })).toEqual([p.id]);
    expect(await idsMatching("lookou", { member: false })).toEqual([]);
  });

  it("scopes the words to public items, a collection, or items on the map, and ranks the best first", async () => {
    const pub = await db.trip.create({ data: { slug: "p", title: "Public", visibility: "PUBLIC", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const priv = await db.trip.create({ data: { slug: "q", title: "Private", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const weak = await photo({ tripId: pub.id, caption: "A pier", context: null, lat: 1, lng: 1 });
    await db.photo.update({ where: { id: weak.id }, data: { placeName: "harbor" } });
    const strong = await photo({ tripId: pub.id, caption: "Harbor, harbor, harbor at dawn", title: "Harbor" });
    const hidden = await photo({ tripId: priv.id, caption: "Harbor again" });
    const col = await db.collection.create({ data: { slug: "c", title: "C", createdById: dana } });
    await db.collectionItem.create({ data: { collectionId: col.id, photoId: hidden.id, addedById: dana } });
    expect((await idsMatching("harbor", { member: false, scope: { publicOnly: true } })).sort()).toEqual([weak.id, strong.id].sort());
    expect(await idsMatching("harbor", { member: true, scope: { collectionId: col.id } })).toEqual([hidden.id]);
    expect(await idsMatching("harbor", { member: true, scope: { tripId: pub.id, placed: true } })).toEqual([weak.id]);
    // The caption and title say it three times over; the place once.
    expect(await idsMatching("harbor", { member: true, scope: { tripId: pub.id } })).toEqual([strong.id, weak.id]);
    expect(await idsMatching("harbor", { member: true, scope: { tripId: pub.id }, limit: 1 })).toEqual([strong.id]);
  });

  it("looks for a % or an _ as typed", async () => {
    const a = await photo({ caption: "100% sure" });
    await photo({ caption: "100 percent" });
    expect(await idsMatching("0%", { member: true })).toEqual([a.id]);
    expect(await idsMatching("_", { member: true })).toEqual([]);
  });

  it("keeps text for members when anybody is tagged on the photograph, a face as much as a pet", async () => {
    const p = await photo({});
    expect(await writtenFromMembersOnly(p.id, record(), null)).toBe(false);
    const ada = await db.person.create({ data: { name: "Ada", createdById: dana } });
    await db.face.create({ data: { photoId: p.id, personId: ada.id, box: {}, confidence: 1, status: "CONFIRMED" } });
    expect(await writtenFromMembersOnly(p.id, record(), null)).toBe(true);
  });

  it("judges an answer by what its request carried, whatever has changed since", async () => {
    const p = await photo({});
    // Notes and names were sent; by the time the answer lands both are gone, and it is still the family's.
    await applyAnnotation(p.id, "m", record(), {}, { sent: true });
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, title: null, membersTitle: "Mail boat lunch" });
  });

  it("keeps the helper's text for members when it repeats the title of a trip strangers cannot open", async () => {
    const priv = await db.trip.create({ data: { slug: "q", title: "Hopkins weekend", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: priv.id });
    await applyAnnotation(p.id, "m", record({ description: "Coffee at Hopkins before the appointment." }), {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
    const q = await photo({ tripId: priv.id });
    await applyAnnotation(q.id, "m", record(), {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: q.id } })).annotationMembersOnly).toBe(false);
  });

  it("keeps the name and reasons of a guessed place for members when they came from notes or name somebody", async () => {
    const guess = { name: "Towson, Maryland", precision: "city" as const, lat: 39.4, lng: -76.6, radiusM: 5000, confidence: 0.8, evidence: "the church spire" };
    const plain = await photo({});
    await applyPlaceEstimate(plain.id, guess);
    expect((await db.photo.findUniqueOrThrow({ where: { id: plain.id } })).placeEstimateMembersOnly).toBe(false);
    const noted = await photo({ context: "at Nana's in Towson" });
    await applyPlaceEstimate(noted.id, guess);
    expect((await db.photo.findUniqueOrThrow({ where: { id: noted.id } })).placeEstimateMembersOnly).toBe(true);
    const named = await photo({});
    await applyPlaceEstimate(named.id, { ...guess, evidence: "Dana's street sign" });
    expect((await db.photo.findUniqueOrThrow({ where: { id: named.id } })).placeEstimateMembersOnly).toBe(true);
  });

  it("re-judges what was written before a name was known, in the background, moving only the helper's own title", async () => {
    const trip = await db.trip.create({ data: { slug: "t", title: "Coast", visibility: "PUBLIC", description: "A week with Biscuit.", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id });
    await applyAnnotation(p.id, "m", record({ title: "Biscuit on the boat", caption: "Biscuit on the deck" }), {});
    const typed = await photo({ tripId: trip.id, title: "Biscuit's birthday", titleByHelper: false });
    await applyAnnotation(typed.id, "m", record({ caption: "Biscuit and a cake" }), {});
    // Adding somebody changes nothing by itself: the request that added them does not rewrite the album.
    await db.person.create({ data: { name: "Biscuit", kind: "PET", createdById: dana } });
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(false);
    const r = await rejudgeNames(["Biscuit"]);
    expect(r).toMatchObject({ photos: 2, descriptions: 1 });
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, title: null, membersTitle: "Biscuit on the boat" });
    // A title the family typed stays theirs to publish, names and all.
    expect(await db.photo.findUniqueOrThrow({ where: { id: typed.id } })).toMatchObject({ annotationMembersOnly: true, title: "Biscuit's birthday" });
    expect((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).descriptionMembersOnly).toBe(true);
    // Strangers find only what the family published themselves.
    expect((await searchMedia(anon, { q: "biscuit" }, 120, null)).map((h) => h.id)).toEqual([typed.id]);
    // Asked again, nothing more happens.
    expect((await rejudgeNames(["Biscuit"])).photos).toBe(0);
  });

  it("leaves alone what a member chose to show to everyone", async () => {
    const p = await photo({});
    await applyAnnotation(p.id, "m", record({ caption: "Rex asleep on the deck" }), {});
    await db.photo.update({ where: { id: p.id }, data: { annotationSharedAt: new Date() } });
    await db.person.create({ data: { name: "Rex", kind: "PET", createdById: dana } });
    expect((await rejudgeNames(["Rex"])).photos).toBe(0);
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(false);
  });

  it("flags the most-named of all — nothing is skipped for being everywhere", async () => {
    const trip = await db.trip.create({ data: { slug: "sea", title: "Seaside", visibility: "PUBLIC", description: "Ada's first summer by the sea.", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    for (let i = 0; i < 30; i++) await photo({ tripId: trip.id, annotation: { title: "", caption: "Ada and Ben build a sandcastle", description: "", tags: [], searchSummary: "" } });
    for (let i = 0; i < 70; i++) await photo({ tripId: trip.id, annotation: { title: "", caption: "Waves", description: "", tags: [], searchSummary: "" } });
    await db.person.create({ data: { name: "Ada", createdById: dana } });
    const r = await rejudgeNames(["Ada"]);
    expect(r.photos).toBe(30);
    expect((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).descriptionMembersOnly).toBe(true);
    // An everyday word is still only a name with a capital.
    await photo({ annotation: { title: "", caption: "Castles in the sand", description: "", tags: [], searchSummary: "" } });
    expect((await rejudgeNames(["Sand"])).photos).toBe(0);
  });

  it("flags a row that was touched but not rewritten since it was read, and not one whose words changed", async () => {
    const p = await photo({ annotation: { title: "", caption: "Ada on the dock", description: "", tags: [], searchSummary: "" } });
    const read = () => db.photo.findUniqueOrThrow({ where: { id: p.id }, include: { trip: true, collections: { include: { collection: true } } } });
    const stale = await read();
    // Something else moves updatedAt (a trip's visibility bump, a face, processing): the words are the same.
    await new Promise((r) => setTimeout(r, 5));
    await db.photo.update({ where: { id: p.id }, data: { updatedAt: new Date(), caption: "Dock" } });
    expect(await flagPhoto(stale as never, null, null)).toBe(true);
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);

    const q = await photo({ annotation: { title: "", caption: "Ada on the dock", description: "", tags: [], searchSummary: "" } });
    const before = await db.photo.findUniqueOrThrow({ where: { id: q.id }, include: { trip: true, collections: { include: { collection: true } } } });
    await db.photo.update({ where: { id: q.id }, data: { annotation: { title: "", caption: "The dock", description: "", tags: [], searchSummary: "" } } });
    expect(await flagPhoto(before as never, null, null)).toBe(false);
    expect((await db.photo.findUniqueOrThrow({ where: { id: q.id } })).annotationMembersOnly).toBe(false);
  });

  it("judges a missed write again, and records a name as judged only when every write landed", async () => {
    const ada = await db.person.create({ data: { name: "Ada", createdById: dana } });
    const p = await photo({ annotation: { title: "", caption: "Ada on the dock", description: "", tags: [], searchSummary: "" } });
    // The first write misses (the row changed under it); the job reads it again and lands the second.
    const real = db.photo.updateMany.bind(db.photo);
    let misses = 1;
    const spy = vi.spyOn(db.photo, "updateMany").mockImplementation(((args: never) => (misses-- > 0 ? Promise.resolve({ count: 0 }) : real(args))) as never);
    const once = await rejudgeText({ names: ["Ada"] });
    expect(once).toMatchObject({ photos: 1, missed: 0 });
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyNames).toEqual([`person:${ada.id}:Ada`]);

    // Every write misses: nothing is recorded, so the next sweep tries the name again.
    await db.appSetting.update({ where: { id: "app" }, data: { membersOnlyNames: [] } });
    await db.photo.update({ where: { id: p.id }, data: { annotationMembersOnly: false } });
    spy.mockImplementation((() => Promise.resolve({ count: 0 })) as never);
    const never = await rejudgeText({ names: ["Ada"] });
    expect(never.missed).toBeGreaterThan(0);
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyNames).toEqual([]);
    spy.mockRestore();
  });

  it("takes an old helper title off an item that is already members-only, and leaves a typed one", async () => {
    const trip = await db.trip.create({ data: { slug: "c", title: "Cake", visibility: "PUBLIC", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    await db.person.create({ data: { name: "Ada", createdById: dana } });
    // Described from notes long ago as "Ada's birthday cake" (the answer since purged), described again as "Cake table".
    const old = await photo({ tripId: trip.id, context: "Ada turns five", title: "Ada's birthday cake", annotationMembersOnly: true, annotation: { title: "Cake table", caption: "The cake table", description: "", tags: [], searchSummary: "" } });
    const typed = await photo({ tripId: trip.id, context: "Ada turns five", title: "Ada's day", titleByHelper: false, annotationMembersOnly: true, annotation: { title: "Cake table", caption: "The cake table", description: "", tags: [], searchSummary: "" } });
    const r = await rejudgeNames();
    expect(r.titles).toBe(1);
    expect(await db.photo.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ title: null, membersTitle: "Cake table" });
    expect(await db.photo.findUniqueOrThrow({ where: { id: typed.id } })).toMatchObject({ title: "Ada's day" });
  });

  it("never lifts a flag because a private trip was renamed", async () => {
    const trip = await db.trip.create({ data: { slug: "tahoe", title: "Tahoe weekend", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id });
    await applyAnnotation(p.id, "m", record({ title: "Skiing at Tahoe", caption: "Skiing at Tahoe" }), {});
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, annotationTitleOnly: true });
    // Renamed: the old title's words are still in the text, and a rename only ever adds.
    await db.trip.update({ where: { id: trip.id }, data: { title: "Spring 2025" } });
    await rejudgeTitles({ tripId: trip.id });
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
  });

  it("never lifts a flag from text that names somebody the album knows, even before that name has been judged", async () => {
    const trip = await db.trip.create({ data: { slug: "tahoe", title: "Tahoe weekend", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id });
    await applyAnnotation(p.id, "m", record({ title: "Emma skiing at Tahoe", caption: "Emma skiing at Tahoe" }), {});
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, annotationTitleOnly: true });
    // Emma is added; her own judging has not run when the trip is made public.
    await db.person.create({ data: { name: "Emma", createdById: dana } });
    await db.trip.update({ where: { id: trip.id }, data: { visibility: "PUBLIC" } });
    const r = await rejudgeTitles({ tripId: trip.id });
    expect(r.unflagged).toBe(0);
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, annotationTitleOnly: false });
    expect(await searchMedia(anon, { q: "emma" }, 120, null)).toEqual([]);
  });

  it("sweeps the whole album when the matcher changes, and afterwards only names it has not judged", async () => {
    const p = await photo({ annotation: { title: "", caption: "Rex on the rug", description: "", tags: [], searchSummary: "" } });
    await db.person.create({ data: { name: "Rex", kind: "PET", createdById: dana } });
    await rejudgeSweep();
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyMatcher).toBe(MATCHER_VERSION);
    // A rename whose job never ran is judged by the next sweep.
    const q = await photo({ annotation: { title: "", caption: "Biscuit on the rug", description: "", tags: [], searchSummary: "" } });
    await db.person.create({ data: { name: "Biscuit", kind: "PET", createdById: dana } });
    await rejudgeSweep();
    expect((await db.photo.findUniqueOrThrow({ where: { id: q.id } })).annotationMembersOnly).toBe(true);
    // Somebody removed and added again under the same name is somebody new to judge.
    await db.person.deleteMany({ where: { name: "Rex" } });
    await rejudgeSweep();
    const r2 = await photo({ annotation: { title: "", caption: "Rex asleep again", description: "", tags: [], searchSummary: "" } });
    await db.person.create({ data: { name: "Rex", kind: "PET", createdById: dana } });
    const started = new Date();
    await rejudgeSweep();
    expect((await db.photo.findUniqueOrThrow({ where: { id: r2.id } })).annotationMembersOnly).toBe(true);
    // The sweep is stamped with when it started, so a change made while it ran is looked at again next time.
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyJudgedAt!.getTime()).toBeGreaterThanOrEqual(started.getTime());
    // A photograph that joined a private collection since is judged against its title.
    const joined = await photo({ annotation: { title: "", caption: "Waiting at Hopkins", description: "", tags: [], searchSummary: "" } });
    const col = await db.collection.create({ data: { slug: "hop", title: "Hopkins", createdById: dana } });
    await rejudgeSweep();
    await db.collectionItem.create({ data: { collectionId: col.id, photoId: joined.id, addedById: dana } });
    await rejudgeSweep();
    expect(await db.photo.findUniqueOrThrow({ where: { id: joined.id } })).toMatchObject({ annotationMembersOnly: true, annotationTitleOnly: true, annotationTitleWords: ["hopkins"], annotationTitleFrom: [`collection:${col.id}`] });
  });

  it("lifts a flag that was only for a private trip's title once the trip is public, and puts it back when it is not", async () => {
    const trip = await db.trip.create({ data: { slug: "h", title: "Hopkins weekend", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id });
    await applyAnnotation(p.id, "m", record({ title: "Hopkins lobby", description: "Coffee at Hopkins." }), {});
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, annotationTitleOnly: true, title: null, membersTitle: "Hopkins lobby" });
    const activity = await db.activity.create({ data: { tripId: trip.id, title: "Walk", startTime: new Date("2025-01-01T10:00:00Z"), endTime: new Date("2025-01-01T11:00:00Z"), description: "Out of Hopkins for an hour." } });
    await rejudgeTitles({ tripId: trip.id });
    expect(await db.activity.findUniqueOrThrow({ where: { id: activity.id } })).toMatchObject({ descriptionMembersOnly: true, descriptionTitleOnly: true });

    await db.trip.update({ where: { id: trip.id }, data: { visibility: "PUBLIC" } });
    const lifted = await rejudgeTitles({ tripId: trip.id });
    expect(lifted.unflagged).toBe(1);
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: false, annotationTitleOnly: false, title: "Hopkins lobby", membersTitle: null });
    expect(await db.activity.findUniqueOrThrow({ where: { id: activity.id } })).toMatchObject({ descriptionMembersOnly: false, descriptionTitleOnly: false });

    await db.trip.update({ where: { id: trip.id }, data: { visibility: "PRIVATE" } });
    await rejudgeTitles({ tripId: trip.id });
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, annotationTitleOnly: true, title: null });
    // A name outranks a title word: that one stays when the trip goes public.
    const q = await photo({ tripId: trip.id, context: "Nana's appointment" });
    await applyAnnotation(q.id, "m", record({ description: "Coffee at Hopkins." }), {});
    await db.trip.update({ where: { id: trip.id }, data: { visibility: "PUBLIC" } });
    await rejudgeTitles({ tripId: trip.id });
    expect((await db.photo.findUniqueOrThrow({ where: { id: q.id } })).annotationMembersOnly).toBe(true);
  });

  it("keeps a flag when the photograph moves from a private trip to a public one", async () => {
    const tahoe = await db.trip.create({ data: { slug: "tahoe", title: "Tahoe", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const reno = await db.trip.create({ data: { slug: "reno", title: "Reno", visibility: "PUBLIC", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: tahoe.id });
    await applyAnnotation(p.id, "m", record({ title: "Deck sunset", caption: "Sunset over Tahoe from the deck" }), {});
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationTitleOnly: true, annotationTitleWords: ["tahoe"], annotationTitleFrom: [`trip:${tahoe.id}`] });
    await db.photo.update({ where: { id: p.id }, data: { tripId: reno.id } });
    expect((await rejudgeTitles({ tripId: reno.id })).unflagged).toBe(0);
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
    expect(await searchMedia(anon, { q: "tahoe" }, 120, null)).toEqual([]);
  });

  it("keeps a flag for a renamed-away title, whatever is published afterwards", async () => {
    const trip = await db.trip.create({ data: { slug: "nana", title: "Nana's 80th", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const cakes = await db.collection.create({ data: { slug: "cakes", title: "Cakes", createdById: dana } });
    const p = await photo({ tripId: trip.id });
    await db.collectionItem.create({ data: { collectionId: cakes.id, photoId: p.id, addedById: dana } });
    await applyAnnotation(p.id, "m", record({ title: "The cake", caption: "The cake for Nana's 80th" }), {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationTitleOnly).toBe(true);
    await db.trip.update({ where: { id: trip.id }, data: { title: "Summer" } });
    await db.collection.update({ where: { id: cakes.id }, data: { visibility: "PUBLIC" } });
    expect((await rejudgeTitles({ collectionId: cakes.id })).unflagged).toBe(0);
    // Even the trip itself going public does not publish words its title no longer carries.
    await db.trip.update({ where: { id: trip.id }, data: { visibility: "PUBLIC" } });
    expect((await rejudgeTitles({ tripId: trip.id })).unflagged).toBe(0);
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
    expect(await searchMedia(anon, { q: "nana" }, 120, null)).toEqual([]);
  });
});
