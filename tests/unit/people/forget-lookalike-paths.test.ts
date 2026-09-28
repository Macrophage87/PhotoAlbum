import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { forgetPerson } from "@/lib/people/forget-person";
import { looseMatcher, memberTextMentioning, namesSomebodyRestricted, scrubWithdrawnNames, withoutWithdrawnNames } from "@/lib/people/forget";
import { nameMatcher } from "@/lib/people/scrub";
import { forgottenScope, loadTombstone } from "@/lib/people/tombstone";
import { photoUrl } from "@/lib/photos/urls";
import type { LeftoverItems } from "@/lib/people/forget";
import { annotationSchema, type StoredAnnotation } from "@/lib/annotation/schema";
import { applyAnnotation } from "@/lib/annotation/apply";

/**
 * "Santa Barbara Pier" is nobody. Forgetting Barbara Jones, or somebody whose whole name is Barbara, must neither
 * rewrite nor list it on any path the forget, the withdrawn-name scrub or the leftover list reads — only on and
 * around the photographs she is tagged on is her first name alone hers.
 */
const PIER = "Santa Barbara Pier";

describe.each([["Barbara Jones"], ["Barbara"]])("forgetting %s, on every text path", (name) => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });

  const photo = (data: Record<string, unknown>) => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });
  const helper: StoredAnnotation = { title: PIER, caption: `${PIER} At Sunset`, description: `The ${PIER} at dusk.`, tags: ["santa barbara", "pier"], place: PIER, activity: null, objects: [], visibleText: "SANTA BARBARA PIER", season: "summer", mood: null, searchSummary: "santa barbara pier sunset" };

  /** Everything the fixture holds, keyed by path. */
  async function fixture() {
    const person = await db.person.create({ data: { name, createdById: admin } });
    // Her own photograph: her first name alone is hers there.
    const hers = await photo({ title: "Barbara At The Lake", titleByHelper: true, annotation: { ...helper, title: "Barbara At The Lake", caption: "Barbara at the lake" } });
    await db.face.create({ data: { photoId: hers.id, personId: person.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    const helpers = await photo({ title: PIER, titleByHelper: true, annotation: helper, annotatedAt: new Date(), placeEstimateName: PIER, placeEstimateNote: `the ${PIER} sign`, estimatedDateNote: `2019: ${PIER} rebuilt`, placeName: PIER, originalName: `${PIER}.jpg` });
    await db.mediaAnnotationRaw.create({ data: { photoId: helpers.id, model: "m", response: { content: [{ type: "text", text: JSON.stringify(helper) }] } } });
    const members = await photo({ title: PIER, titleByHelper: false, membersTitle: `${PIER} Walk`, caption: "Santa Barbara Trip With The Kids", context: "Santa Barbara Weekend", trashNote: `Same as the ${PIER} one` });
    await db.photoLink.create({ data: { photoAId: members.id, photoBId: helpers.id, relation: "RELATED", note: `${PIER}, the other angle` } });
    const trip = await db.trip.create({ data: { slug: "coast", title: "Santa Barbara Favourites", description: `${PIER} At Sunset`, descriptionByHelper: true, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-11"), createdById: admin } });
    const memberTrip = await db.trip.create({ data: { slug: "coast-2", title: "Coast", description: "Santa Barbara Weekend", descriptionByHelper: false, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-11"), createdById: admin } });
    const activity = await db.activity.create({ data: { tripId: trip.id, title: `${PIER} Walk`, description: `${PIER} Walk`, descriptionByHelper: true, startTime: new Date("2025-08-10T10:00:00Z"), endTime: new Date("2025-08-10T11:00:00Z") } });
    const collection = await db.collection.create({ data: { slug: "favourites", title: "Santa Barbara Weekend", description: "Santa Barbara Trip With The Kids", descriptionByHelper: false, createdById: admin } });
    const helperCollection = await db.collection.create({ data: { slug: "pier", title: "Pier", description: `${PIER} At Sunset`, descriptionByHelper: true, createdById: admin } });
    const other = await db.person.create({ data: { name: "Ben Ortiz", relationship: `Met at the ${PIER}`, createdById: admin } });
    const track = await db.track.create({ data: { tripId: trip.id, uploaderId: admin, source: "GPX", name: `${PIER} Walk`, originalFile: `${PIER} Walk.gpx`, startTime: new Date("2025-08-10T10:00:00Z"), endTime: new Date("2025-08-10T11:00:00Z"), pointCount: 0, minLat: 0, maxLat: 0, minLng: 0, maxLng: 0, simplified: [], pointsBlob: new Uint8Array() } });
    const report = await db.takeoutImport.create({ data: { archiveName: "takeout.zip", startedById: admin, report: { albums: [PIER] } } });
    return { person, hers, helpers, members, trip, memberTrip, activity, collection, helperCollection, other, track, report };
  }

  it("rewrites and lists none of it, and still takes her first name out of her own photograph", async () => {
    const f = await fixture();
    // What a member would be told before forgetting her.
    const before = await memberTextMentioning(nameMatcher([name], []), new Set([f.hers.id]), f.person.id, Infinity);
    await forgetPerson(f.person.id, { keepName: false, byUserId: admin });

    const helpers = await db.photo.findUniqueOrThrow({ where: { id: f.helpers.id } });
    const members = await db.photo.findUniqueOrThrow({ where: { id: f.members.id } });
    const hers = await db.photo.findUniqueOrThrow({ where: { id: f.hers.id } });
    const [left] = await db.forgetLeftover.findMany();
    const items = (left?.items ?? {}) as Partial<LeftoverItems>;
    const listed = (xs: { id?: string }[] | undefined, id: string) => (xs ?? []).some((x) => x.id === id);
    const listedBefore = (xs: { id: string }[], id: string) => xs.some((x) => x.id === id);

    const rows: [string, unknown, unknown][] = [
      ["helper's title", helpers.title, PIER],
      ["helper's record", helpers.annotation, helper],
      ["place guess", [helpers.placeEstimateName, helpers.placeEstimateNote, helpers.estimatedDateNote], [PIER, `the ${PIER} sign`, `2019: ${PIER} rebuilt`]],
      ["raw answer kept", await db.mediaAnnotationRaw.count({ where: { photoId: f.helpers.id } }), 1],
      ["trip description (helper's, none of her photos)", (await db.trip.findUniqueOrThrow({ where: { id: f.trip.id } })).description, `${PIER} At Sunset`],
      ["activity description (helper's)", (await db.activity.findUniqueOrThrow({ where: { id: f.activity.id } })).description, `${PIER} Walk`],
      ["collection description (helper's)", (await db.collection.findUniqueOrThrow({ where: { id: f.helperCollection.id } })).description, `${PIER} At Sunset`],
      ["member's photo words", [members.title, members.membersTitle, members.caption, members.context], [PIER, `${PIER} Walk`, "Santa Barbara Trip With The Kids", "Santa Barbara Weekend"]],
      ["listed: photos", [listed(items.photos, f.helpers.id), listed(items.photos, f.members.id)], [false, false]],
      ["listed: trips", [listed(items.trips, f.trip.id), listed(items.trips, f.memberTrip.id)], [false, false]],
      ["listed: collections", [listed(items.collections, f.collection.id), listed(items.collections, f.helperCollection.id)], [false, false]],
      ["listed: activities", listed(items.activities, f.activity.id), false],
      ["listed: other people", listed(items.people, f.other.id), false],
      ["listed: tracks", listed(items.tracks, f.track.id), false],
      ["listed: imports", listed(items.imports, f.report.id), false],
      ["shown before forgetting: photos", [listedBefore(before.photos, f.helpers.id), listedBefore(before.photos, f.members.id)], [false, false]],
      ["shown before forgetting: containers", [before.trips.length, before.collections.length, before.activities.length], [0, 0, 0]],
      ["her own photograph", [hers.title, (hers.annotation as StoredAnnotation).caption], ["A Family Member At The Lake", "A family member at the lake"]],
    ];
    expect(rows.filter(([, got, want]) => !isDeepStrictEqual(got, want))).toEqual([]);
  });

  it("a withdrawn naming neither publishes nor rewrites a match only the neighbour rule would excuse", async () => {
    const f = await fixture();
    await db.person.update({ where: { id: f.person.id }, data: { namingWithdrawnAt: new Date() } });
    // Show to everyone is refused; the nightly public pass keeps the words for members, as written.
    expect((await withoutWithdrawnNames(f.helpers.id, { annotation: helper, title: PIER })).hold).toBe(true);
    await scrubWithdrawnNames();
    const after = await db.photo.findUniqueOrThrow({ where: { id: f.helpers.id } });
    expect(after).toMatchObject({ annotation: helper, annotationMembersOnly: true, title: null, membersTitle: PIER, placeEstimateName: PIER, placeEstimateMembersOnly: true });
    expect(await db.trip.findUniqueOrThrow({ where: { id: f.trip.id } })).toMatchObject({ description: `${PIER} At Sunset`, descriptionMembersOnly: true });
    expect((await db.photo.findUniqueOrThrow({ where: { id: f.hers.id } })).title).toBe("A Family Member At The Lake");
  });

  it("the queue's file names and the typed fields' matcher leave it alone", () => {
    const loose = looseMatcher(nameMatcher([name], []));
    for (const t of [PIER, `${PIER}.jpg`, `${PIER} Walk.gpx`, JSON.stringify({ albums: [PIER] }), `Met at the ${PIER}`]) expect([t, loose(t)]).toEqual([t, false]);
  });
});

/**
 * And the other side of it: away from her photographs her first name in plain prose is still hers, as it always
 * was — on a photograph whose notes name her, on one whose helper's words alone do, and for a naming withdrawn
 * from a minor, which is what keeps it out of what everyone may read.
 */
describe("a first name in prose away from her photographs is still hers", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const photo = (data: Record<string, unknown>) => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });
  const record = (caption: string, tags: string[] = []): StoredAnnotation => ({ title: "", caption, description: "", tags, place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "" });

  it("S1: notes that name her in full make the photograph hers, and the helper's first name goes", async () => {
    const barbara = await db.person.create({ data: { name: "Barbara Jones", createdById: admin } });
    const p = await photo({ context: "Barbara Jones turns 80 at the lake house", annotation: record("Barbara blows out the candles"), annotatedAt: new Date() });
    await forgetPerson(barbara.id, { keepName: false, byUserId: admin });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation as StoredAnnotation).caption).toBe("A family member blows out the candles");
  });

  it("S2: the helper's first name in prose goes, with its raw answer and tag, and the notes are listed", async () => {
    const barbara = await db.person.create({ data: { name: "Barbara Jones", createdById: admin } });
    const helper = record("Barbara blows out the candles on her 80th", ["barbara", "cake"]);
    const p = await photo({ context: "Barbara's 80th", annotation: helper, annotatedAt: new Date() });
    await db.mediaAnnotationRaw.create({ data: { photoId: p.id, model: "m", response: { content: [{ type: "text", text: JSON.stringify(helper) }] } } });
    await forgetPerson(barbara.id, { keepName: false, byUserId: admin });
    const a = (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation as StoredAnnotation;
    expect(a).toMatchObject({ caption: "A family member blows out the candles on her 80th", tags: ["cake"] });
    expect(await db.mediaAnnotationRaw.count({ where: { photoId: p.id } })).toBe(0);
    const [left] = await db.forgetLeftover.findMany();
    expect((left.items as LeftoverItems).photos).toEqual([{ id: p.id, fields: ["notes"] }]);
  });

  it("S4: a naming withdrawn from a minor keeps her first name out of what everyone may read", async () => {
    const mia = await db.person.create({ data: { name: "Mia Kent", birthday: new Date("2019-01-01"), namingWithdrawnAt: new Date(), createdById: admin } });
    const p = await photo({ annotation: record("Mia blows bubbles"), annotatedAt: new Date() });
    const shown = await withoutWithdrawnNames(p.id, { annotation: record("Mia blows bubbles"), title: "Mia Blows Bubbles" });
    // Her name in prose is taken out; beside "Blows" in a title it may be somebody else's, so none of it is shown.
    expect((shown.annotation as StoredAnnotation).caption).toBe("A family member blows bubbles");
    expect(shown.hold).toBe(true);
    expect(mia.id).toBeTruthy();
  });

  it("S5: the nightly pass after the fortnight reaches her first name alone in words kept for members", async () => {
    const mia = await db.person.create({ data: { name: "Mia Kent", birthday: new Date("2019-01-01"), namingWithdrawnAt: new Date(Date.now() - 30 * 86_400_000), createdById: admin } });
    const p = await photo({ annotation: record("Mia blows bubbles at her party"), annotationMembersOnly: true, annotatedAt: new Date() });
    await scrubWithdrawnNames();
    expect(((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation as StoredAnnotation).caption).toBe("A family member blows bubbles at her party");
    expect(mia.id).toBeTruthy();
  });

  it("a saint's name with a dot stays a church's, in the words, the keywords and the tags, where her name is taken out", async () => {
    const mary = await db.person.create({ data: { name: "Mary Kemp", createdById: admin } });
    const p = await photo({ annotation: { ...record("Mary holds the baby. Christening at St. Mary's church.", ["st. mary's church", "mary's baby"]), searchSummary: "mary baby christening st. mary's church" }, annotatedAt: new Date() });
    await forgetPerson(mary.id, { keepName: false, byUserId: admin });
    const a = (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation as StoredAnnotation;
    expect(a.caption).toBe("A family member holds the baby. Christening at St. Mary's church.");
    expect(a.searchSummary).toContain("st. mary's church");
    expect(a.searchSummary).not.toMatch(/^mary/);
    expect(a.tags).toEqual(["st. mary's church"]);
  });

  it("takes her surname alone out of the search summary of a photograph about her, and nowhere else", async () => {
    const ruth = await db.person.create({ data: { name: "Ruth Jones", createdById: admin } });
    const hers = await photo({ annotation: { ...record("A picnic"), searchSummary: "jones family reunion picnic" }, annotatedAt: new Date() });
    await db.face.create({ data: { photoId: hers.id, personId: ruth.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    const named = await photo({ annotation: { ...record("Ruth waves"), searchSummary: "jones family picnic" }, annotatedAt: new Date(), context: "Ruth Jones at the reunion" });
    const beach = await photo({ annotation: { ...record("Ruth at the beach"), searchSummary: "jones beach picnic" }, annotatedAt: new Date(), context: "Ruth Jones at the beach" });
    const others = await photo({ annotation: { ...record("A picnic"), searchSummary: "jones family reunion" }, annotatedAt: new Date() });
    await forgetPerson(ruth.id, { keepName: false, byUserId: admin });
    const summary = async (id: string) => ((await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation).searchSummary;
    expect([await summary(hers.id), await summary(named.id), await summary(beach.id), await summary(others.id)]).toEqual(["A family member family reunion picnic", "A family member family picnic", "jones beach picnic", "jones family reunion"]);
  });

  it("the withdrawn pass reaches a helper's trip description that gives only her first name", async () => {
    await db.person.create({ data: { name: "Mia Kent", birthday: new Date("2019-01-01"), namingWithdrawnAt: new Date(Date.now() - 30 * 86_400_000), createdById: admin } });
    const trip = await db.trip.create({ data: { slug: "lake", title: "The lake", description: "Mia's party at the lake, with bubbles.", descriptionByHelper: true, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-11"), createdById: admin } });
    await scrubWithdrawnNames();
    expect((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).description).toBe("A family member's party at the lake, with bubbles.");
  });

  it("S3: once the record's words name her, her first name leaves its keywords and tags too", async () => {
    const barbara = await db.person.create({ data: { name: "Barbara Jones", createdById: admin } });
    const p = await photo({ annotation: { ...record("Barbara blows out the candles on her 80th", ["barbara's 80th", "cake"]), searchSummary: "barbara birthday 80th candles" }, annotatedAt: new Date() });
    await forgetPerson(barbara.id, { keepName: false, byUserId: admin });
    const a = (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation as StoredAnnotation;
    expect(a.tags).toEqual(["cake"]);
    expect(a.searchSummary).not.toMatch(/barbara/i);
  });

  describe.each([["Ximena At The Hut"], ["XIMENA AT THE HUT"], ["Ximena And Ben At The Hut"], ["Ximena Beside The Lake"]])("a helper's title %s", (title) => {
    const annotated = (t: string) => photo({ title: t, titleByHelper: true, annotation: { ...record(`${t}, in the snow.`), title: t }, annotatedAt: new Date() });
    const gone = (t: string | null | undefined) => !/ximena/i.test(t ?? "");

    it("is never shown to everyone while a naming is withdrawn, nor left by the nightly public pass", async () => {
      await db.person.create({ data: { name: "Ximena", namingWithdrawnAt: new Date(), createdById: admin } });
      const p = await annotated(title);
      const shown = await withoutWithdrawnNames(p.id, { annotation: (await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation, title });
      expect([gone(shown.title), gone((shown.annotation as StoredAnnotation).title), gone((shown.annotation as StoredAnnotation).caption)]).toEqual([true, true, true]);
      await scrubWithdrawnNames();
      const after = await db.photo.findUniqueOrThrow({ where: { id: p.id } });
      expect([gone(after.title), gone((after.annotation as StoredAnnotation).title), gone((after.annotation as StoredAnnotation).caption)]).toEqual([true, true, true]);
    });

    it("is taken out when she is forgotten", async () => {
      const ximena = await db.person.create({ data: { name: "Ximena", createdById: admin } });
      const p = await annotated(title);
      await forgetPerson(ximena.id, { keepName: false, byUserId: admin });
      const after = await db.photo.findUniqueOrThrow({ where: { id: p.id } });
      expect([gone(after.title), gone((after.annotation as StoredAnnotation).title), gone((after.annotation as StoredAnnotation).caption)]).toEqual([true, true, true]);
    });
  });

  it("still leaves every place and every lookalike alone, in title case and in capitals", () => {
    const text = (name: string, t: string) => nameMatcher([name], []).scrub(t, { away: true });
    for (const [name, t] of [
      ["Barbara Jones", "Santa Barbara Pier"], ["Barbara Jones", "SANTA BARBARA PIER"], ["Leo Martin", "Leo Martinez Park At Dusk"], ["Louise Penny", "Sunrise At Lake Louise"], ["Barbara", "Santa Barbara Pier"],
      ["Mary Kemp", "Wedding At St Mary's Church"], ["Mary Kemp", "Christening at St. Mary's church"], ["Mary Kemp", "Ste. Marie's Chapel"], ["Peter Hale", "Saint Peter's Basilica"],
      ["Barbara Jones", "Isle Of Barbara"], ["Barbara Jones", "Church Of St Barbara"], ["Barbara Jones", "Barbara Of Cleves Street"], ["Catherine Wells", "Catherine The Great Palace"],
    ]) expect([name, text(name, t)]).toEqual([name, t]);
    for (const [name, t, want] of [
      ["Barbara Jones", "Barbara And Ben At The Lake", "A Family Member And Ben At The Lake"], ["Barbara Jones", "Barbara At The Party", "A Family Member At The Party"],
      ["Barbara Jones", "Portrait Of Barbara", "Portrait Of A Family Member"], ["Barbara Jones", "The Wedding Of Barbara And Ben", "The Wedding Of A Family Member And Ben"], ["Barbara Jones", "Birthday Cake Of Barbara", "Birthday Cake Of A Family Member"],
    ]) expect([name, text(name, t)]).toEqual([name, want]);
    const loose = looseMatcher(nameMatcher(["Barbara"], []));
    expect(loose("SANTA BARBARA PIER")).toBe(false);
  });
});

/** Deciding what everyone may read while somebody's naming is withdrawn: never a word that may still be them. */
describe("show to everyone and the nightly public pass, for a withdrawn naming", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const record = (title: string, description = ""): StoredAnnotation => ({ title, caption: "", description, tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "" });
  /** What strangers read of the item, by each strict path: nothing while it is held. */
  async function readable(name: string, withdrawn: boolean, title: string, description = "") {
    // Not withdrawn: a grown-up who agreed to be named, whom the album may name anywhere.
    await db.person.create({ data: { name, createdById: admin, ...(withdrawn ? { namingWithdrawnAt: new Date() } : { nameInDescriptions: true, adultAttestedAt: new Date() }) } });
    const a = record(title, description);
    const p = await db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", title, titleByHelper: true, annotation: a, annotatedAt: new Date() } });
    const shown = await withoutWithdrawnNames(p.id, { annotation: a, title });
    const everyone = shown.hold ? "" : [shown.title, (shown.annotation as StoredAnnotation).title, (shown.annotation as StoredAnnotation).description].join("\n");
    await scrubWithdrawnNames();
    const row = await db.photo.findUniqueOrThrow({ where: { id: p.id } });
    const nightly = [row.title, ...(row.annotationMembersOnly ? [] : [(row.annotation as StoredAnnotation).title, (row.annotation as StoredAnnotation).description])].join("\n");
    return { everyone, nightly, row };
  }

  it.each([["Rose At The Hut"], ["ROSE AT THE HUT"], ["Rose at the hut"]])("never shows a withdrawn Rose in %s", async (title) => {
    const r = await readable("Rose", true, title);
    expect([r.everyone, r.nightly].map((t) => /rose/i.test(t))).toEqual([false, false]);
  });

  it("never shows a withdrawn name only the neighbour rule excuses in a description", async () => {
    const r = await readable("Ximena", true, "The hut in winter", "Ximena Hut Walk, in the snow.");
    expect([r.everyone, r.nightly].map((t) => /ximena/i.test(t))).toEqual([false, false]);
  });

  it("holds an everyday word in lower case back from everyone while a naming is withdrawn, and shows everything otherwise", async () => {
    // Show to everyone matches strictly, in any case: refusing leaves the words with the family. The nightly pass
    // still takes an everyday word in lower case for the word.
    const lower = await readable("Rose", true, "a rose by the hut");
    expect([lower.everyone, lower.nightly.split("\n")[0], lower.row.annotationMembersOnly]).toEqual(["", "a rose by the hut", false]);
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const named = await readable("Rose", false, "Rose At The Hut");
    expect([named.everyone.split("\n")[0], named.nightly.split("\n")[0], named.row.annotationMembersOnly]).toEqual(["Rose At The Hut", "Rose At The Hut", false]);
  });
});

/**
 * Places, dates and sayings around a name, when deciding what everyone may read: the share guard for a child (or
 * anybody who may not be named), and show to everyone while a withdrawal waits out its fortnight on a photograph she
 * is not tagged on. A date or a saying is shared as written, and so is "Lake" or "Mount" with a listed place; every
 * other place that holds her name is refused, since a child's name in a headline looks just the same ("Mia Falls
 * Asleep"), and a withdrawal holds whatever may still be her, never publishing the name.
 */
describe("the share guard and a withdrawn naming, around places, dates and sayings", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const record = (text: string): StoredAnnotation => ({ title: text, caption: text, description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "" });

  /** [their name, the helper's words, whether the guard shares them] */
  const ROWS: [string, string, boolean][] = [
    // A month as a date, "Lake" or "Mount" with a listed place, an everyday surname alone, and words that name
    // nobody: shared by the guard. (A withdrawal may still hold them, as the nightly pass does: never garbled.)
    ["May Smith", "Lake day in May, 2019.", true],
    ["May Smith", "May 2019 at the lake", true],
    ["May Smith", "May 5, 2019.", true],
    // A bare "in May." is no date's own shape (the language review's fourth round): refused.
    ["May Smith", "Lake day in May.", false],
    ["May Smith", "In May.", false],
    ["Ruth Baker", "The Baker Street bakery", true],
    ["Geneva Smith", "Lake Geneva at dawn", true],
    ["Geneva Smith", "Lake Geneva.", true],
    ["Victoria Lee", "Mount Victoria at sunrise.", true],
    ["Mia Lopez", "Nothing to see here.", true],
    // Refused: a real mention, and every place excuse that could be one (the language review's B1-B4, the share
    // guard review's attacks and its place-named children).
    ["Louise Smith", "Louise at the lake", false],
    ["Paris Jones", "Paris blows out the candles", false],
    ["Jordan Price", "Jordan at bat.", false],
    ["Austin Blake", "Austin and Leo at the lake.", false],
    ["Madison Clark", "Madison at the lake with Grandpa.", false],
    ["Florence Adams", "Florence and Ben at the Duomo.", false],
    ["May Chen", "Photo of May with her grandmother.", false],
    ["June Carter", "Photo of June.", false],
    ["Mia Lopez", "Mia Falls Asleep In The Car", false],
    ["Mia Lopez", "Mia Springs Into The Pool", false],
    ["Madison Clark", "Madison Square Dancing At School", false],
    ["Mia Lopez", "A day at Crater Lake. Mia caught a frog.", false],
    ["Paris Moreau", "At the Bronx Zoo, Paris fed the goats.", false],
    ["Ximena", "Ximena Beach Day", false],
    ["Ximena", "Ximena Garden Party", false],
    ["Ximena", "Ximena Park Picnic", false],
    ["Ximena", "Ximena Zoo Trip", false],
    ["Ximena", "Fort Ximena", false],
    ["Jordan Price", "Jordan River Walk", false],
    ["Sydney Lee", "Sydney Harbour cruise with Grandpa", false],
    ["Rose", "Rose Garden Party", false],
    ["Paris Moreau", "In Grandpa's Garden, Paris plants tulips.", false],
    ["Madison Clark", "At The Park, Madison Feeds The Ducks", false],
    ["Jordan Price", "By The River, Jordan Skips Stones", false],
    ["Madison Clark", "Madison at the park.", false],
    ["Jordan Price", "Jordan by the river", false],
    ["Geneva Smith", "Lake Geneva Swims", false],
    // Places that may be her are refused too: refusing is the safe side, and members can edit.
    ["Louise Smith", "Lake Louise at dawn", false],
    ["Paris Jones", "The Eiffel Tower, Paris", false],
    ["Brooklyn Jones", "Walking the Brooklyn Bridge", false],
    ["Jordan Lee", "Crossing the Jordan River", false],
    ["Madison Kemp", "Madison Square Garden", false],
    ["Austin Blake", "The Austin skyline from the river.", false],
  ];

  it.each(ROWS)("%s: %s", async (name, text, shares) => {
    // A child by birthday: the share guard's.
    const person = await db.person.create({ data: { name, birthday: new Date("2016-05-01"), createdById: admin } });
    const refused = await namesSomebodyRestricted([text]);
    // A withdrawal in its fortnight, on a photograph she is not tagged on.
    await db.person.update({ where: { id: person.id }, data: { birthday: null, namingWithdrawnAt: new Date() } });
    const p = await db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", title: text, titleByHelper: true, annotation: record(text), annotatedAt: new Date() } });
    const shown = await withoutWithdrawnNames(p.id, { annotation: record(text), title: text });
    const first = name.split(" ")[0];
    const published = shown.hold ? [] : [shown.title, (shown.annotation as StoredAnnotation).title, (shown.annotation as StoredAnnotation).caption];
    if (shares) {
      expect(refused).toBe(false);
      if (!shown.hold) expect(published).toEqual([text, text, text]);
    }
    else expect({ refused, leaked: published.filter((w) => new RegExp(first, "i").test(w ?? "")) }).toEqual({ refused: true, leaked: [] });
    // Never garbled: what is shown is what was written, or what is certainly her taken out ("The Eiffel Tower, A
    // Family Member." is neither).
    expect(published.some((w) => /(?:the|our|my|,)[ \t]+a family member/iu.test(w ?? ""))).toBe(false);
  });
});

/**
 * On her own photograph, the words the forget rewrites and a later answer the forgotten names clean come out alike:
 * a month or a verb that is her name only where it plainly is her, and the stand-in's capitals.
 */
describe("on her own photograph, when she is forgotten and in a later answer", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const record = (caption: string): StoredAnnotation => ({ title: "", caption, description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "" });

  /** [her name, the helper's words, what is left of them] */
  const ROWS: [string, string, string][] = [
    ["May Lee", "May at the lake.", "A family member at the lake."],
    ["May Lee", "May and Ben built a fort.", "A family member and Ben built a fort."],
    ["May Lee", "May swam across.", "A family member swam across."],
    ["May Lee", "May 2020 at the lake.", "May 2020 at the lake."],
    ["May Lee", "A swim in May.", "A swim in a family member."],
    ["May Lee", "A swim in May 2020.", "A swim in May 2020."],
    ["May Lee", "May Day at the fair.", "May Day at the fair."],
    ["Will Turner", "Will swam faster than Ben.", "A family member swam faster than Ben."],
    ["Will Turner", "Will you look at that!", "A family member you look at that!"],
    // "be" says nothing ("Will be ten next week" is him): over-removal is the lesser evil.
    ["Will Turner", "Will be fun.", "A family member be fun."],
    ["Ada Byron", "Little Sister Ada and Big Brother Ada.", "A family member and a family member."],
    // A name that is also a verb, used as a name (the language review's B5).
    ["Will Turner", "Will not impressed by the snow.", "A family member not impressed by the snow."],
    ["Hope Adams", "Hope so proud of her medal.", "A family member so proud of her medal."],
    // On her own photograph every use is her, the verb and the saying too (the linguist's third review).
    ["May Chen", "May the fourth be with you!", "A family member the fourth be with you!"],
    ["Hope Adams", "Hope you like the pictures!", "A family member you like the pictures!"],
    ["Will Turner", "Will the ring bearer walking down the aisle.", "A family member the ring bearer walking down the aisle."],
    ["Will Turner", "Ben and Will the budding fisherman.", "Ben and a family member the budding fisherman."],
    ["Hope Adams", "Hope the flower girl at Aunt Kay's wedding.", "A family member the flower girl at Aunt Kay's wedding."],
    ["May Chen", "May the birthday girl, blowing out candles.", "A family member the birthday girl, blowing out candles."],
    ["May Chen", "May this morning at the park.", "A family member this morning at the park."],
    ["Hope Adams", "Hope this morning, all smiles.", "A family member this morning, all smiles."],
    ["Hope Adams", "Hope my little helper in the kitchen.", "A family member my little helper in the kitchen."],
    ["May Chen", "May our little mermaid in the pool.", "A family member our little mermaid in the pool."],
    ["Will Turner", "Will our little explorer on the trail.", "A family member our little explorer on the trail."],
    // A month on her own photograph is her unless a date says otherwise (the language review's S1).
    ["May Chen", "Goodnight May.", "Goodnight a family member."],
    ["May Chen", "May can swim now!", "A family member can swim now!"],
    ["June Carter", "June on the swings.", "A family member on the swings."],
    ["April Reyes", "Nap time for April.", "Nap time for a family member."],
    ["August Lind", "August in the pool with Dad.", "A family member in the pool with Dad."],
    ["May Chen", "May, 7, and Ben, 5, at the lake.", "A family member, 7, and Ben, 5, at the lake."],
    ["April Reyes", "Easter in April, the whole family.", "Easter in a family member, the whole family."],
    // A month that is her name: plainly her (S1), or the month (S2, the first review's "June waves").
    ["May Chen", "May's first day of school.", "A family member's first day of school."],
    ["May Chen", "Happy birthday, May!", "Happy birthday, a family member!"],
    ["May Chen", "\"May, come look!\" Mom called.", "\"A family member, come look!\" Mom called."],
    ["May Chen", "Photo of May with her grandmother.", "Photo of a family member with her grandmother."],
    ["May Chen", "Grandma and May on the porch.", "Grandma and a family member on the porch."],
    ["May Chen", "Ben, Leo and May on the dock.", "Ben, Leo and a family member on the dock."],
    ["May Chen", "May blowing out the candles on her cake.", "A family member blowing out the candles on her cake."],
    ["May Chen", "May is holding the new puppy.", "A family member is holding the new puppy."],
    ["May Chen", "May loves the swings.", "A family member loves the swings."],
    ["June Carter", "Photo of June.", "Photo of a family member."],
    ["June Carter", "Grandpa holding baby June.", "Grandpa holding a family member."],
    ["June Carter", "Little June in her Easter dress.", "A family member in her Easter dress."],
    ["June Carter", "Sunset with June on the beach.", "Sunset with a family member on the beach."],
    ["June Carter", "June, May and Ben on the dock.", "A family member, May and Ben on the dock."],
    ["June Carter", "The June sun was brutal.", "A family member sun was brutal."],
    ["June Carter", "June waves crashed on the rocks.", "A family member waves crashed on the rocks."],
    // A month only as a plain date: after a date word, at the end or before a year ("Late June.", "Late June 2019").
    ["June Carter", "Late June at the lake house.", "Late a family member at the lake house."],
    ["June Carter", "At the lake house, late June.", "At the lake house, late a family member."],
    ["June Carter", "At the lake house, late June, 2019.", "At the lake house, late June, 2019."],
    ["June Carter", "Late June 2019 at the lake house.", "Late June 2019 at the lake house."],
    ["May Chen", "Our May trip to the coast.", "Our a family member trip to the coast."],
  ];

  it.each(ROWS)("%s: %s", async (name, text, want) => {
    const person = await db.person.create({ data: { name, createdById: admin } });
    const p = await db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation: record(text), annotatedAt: new Date() } });
    await db.face.create({ data: { photoId: p.id, personId: person.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    await forgetPerson(person.id, { keepName: false, byUserId: admin });
    const caption = async () => ((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotation as StoredAnnotation).caption;
    const forgotten = await caption();
    await applyAnnotation(p.id, "m", annotationSchema.parse({ ...record(text), estimatedYear: null, estimatedPlace: null }), { content: [] }, { requestedAt: new Date() });
    expect({ forgotten, later: await caption() }).toEqual({ forgotten: want, later: want });
  });
});

/** The first review of this round: a row from before places were hashed, notes about the city, and keywords. */
describe("forgotten names kept by place, notes about a place, and keywords", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const photo = (data: Record<string, unknown> = {}) => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });

  it("a whole trip counts a photograph a row from before places were hashed keeps as it is", async () => {
    const ximena = await db.person.create({ data: { name: "Ximena", createdById: admin } });
    const tagged = await photo();
    await db.face.create({ data: { photoId: tagged.id, personId: ximena.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    await forgetPerson(ximena.id, { keepName: false, byUserId: admin });
    const trip = await db.trip.create({ data: { slug: "lake", title: "Lake", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-11"), createdById: admin } });
    const inTrip = await photo({ tripId: trip.id });
    const [row] = await db.forgottenName.findMany();
    await db.forgottenName.update({ where: { hash: row.hash }, data: { photoIds: [inTrip.id], taggedPhotoIds: [], containerIds: [] } });
    const ts = await loadTombstone();
    expect(ts.scrub("Ximena at the lake", await forgottenScope({ containers: [{ kind: "trip", id: trip.id }] }, ts))).toBe("A family member at the lake");
  });

  it("a note of the city with a dome or a church in it is the city's; one with Grandpa or friends in it is hers", async () => {
    const florence = await db.person.create({ data: { name: "Florence", createdById: admin } });
    const own = await photo();
    await db.face.create({ data: { photoId: own.id, personId: florence.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    const city = [await photo({ context: "Florence at sunset with Brunelleschi's dome" }), await photo({ context: "Florence at dusk with Santa Croce" }), await photo({ context: "Florence at night with Ponte Vecchio behind" })];
    // Somebody the album never knew, and somebody forgotten before, are people too.
    const ximena = await db.person.create({ data: { name: "Ximena", createdById: admin } });
    await forgetPerson(ximena.id, { keepName: false, byUserId: admin });
    const hers = await Promise.all(
      ["Florence at sunset with Grandpa", "Florence at sunset, with friends", "Florence at sunset with Olivia", "Florence at sunset with Ximena", "Florence at sunset with two friends", "Florence at sunset with the whole family", "Florence at sunset with all the cousins", "Florence at sunset, with Olivia."].map((context) => photo({ context })),
    );
    await forgetPerson(florence.id, { keepName: false, byUserId: admin });
    const ts = await loadTombstone();
    for (const p of city) expect(ts.scrub("Florence at sunset", await forgottenScope({ photoIds: [p.id] }, ts))).toBe("Florence at sunset");
    for (const p of hers) expect(ts.scrub("Florence smiles", await forgottenScope({ photoIds: [p.id] }, ts))).toBe("A family member smiles");
  });

  it("her surname alone leaves a search summary about her whatever stands before it, but not before a place's word", () => {
    const m = nameMatcher(["Ruth Jones"], []);
    expect(m.scrubKeywords("barbara pier jones family", { tagged: true })).toBe("barbara pier a family member family");
    // On her own photograph strictly, the beach too; on one only its notes say is about her, not.
    expect(m.scrubKeywords("picnic at jones beach", { tagged: true })).toBe("picnic at a family member beach");
    expect(m.scrubKeywords("picnic at jones beach", { tagged: true, noted: true })).toBe("picnic at jones beach");
    // A surname that is an everyday word stays: "price tag".
    expect(nameMatcher(["Ruth Price"], []).scrubKeywords("price tag on the cake", { tagged: true })).toBe("price tag on the cake");
  });
});

/** The hashing review: a forget's rewrite must not change any address strangers can see. */
describe("image addresses around a forget", () => {
  it("stay the same when a forget rewrites a photograph's words, and change when its picture or its trip does", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const ada = await db.person.create({ data: { name: "Ada Byron", createdById: admin } });
    const p = await db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", title: "Ada Byron at the lake", titleByHelper: true, annotation: { title: "Ada Byron at the lake", caption: "Ada Byron swims", description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "" }, annotatedAt: new Date() } });
    await db.face.create({ data: { photoId: p.id, personId: ada.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    const url = async () => photoUrl(await db.photo.findUniqueOrThrow({ where: { id: p.id }, select: { id: true, imageVersion: true } }), "medium");
    const before = await url();
    await forgetPerson(ada.id, { keepName: false, byUserId: admin });
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).title).toBe("A family member at the lake");
    expect(await url()).toBe(before);
    // Its picture, or who may see it, still moves it.
    await db.photo.update({ where: { id: p.id }, data: { edits: { rotate: 90 } } });
    const edited = await url();
    expect(edited).not.toBe(before);
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date(), endDate: new Date(), createdById: admin } });
    await db.photo.update({ where: { id: p.id }, data: { tripId: trip.id } });
    expect(await url()).not.toBe(edited);
  });
});
