import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { forgetPerson } from "@/lib/people/forget-person";
import { looseMatcher, memberTextMentioning, namesSomebodyRestricted, scrubWithdrawnNames, withoutWithdrawnNames } from "@/lib/people/forget";
import { nameMatcher } from "@/lib/people/scrub";
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

  it("still shows an everyday word in lower case, and everything while nobody's naming is withdrawn", async () => {
    const lower = await readable("Rose", true, "a rose by the hut");
    expect([lower.everyone.split("\n")[0], lower.nightly.split("\n")[0], lower.row.annotationMembersOnly]).toEqual(["a rose by the hut", "a rose by the hut", false]);
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    const named = await readable("Rose", false, "Rose At The Hut");
    expect([named.everyone.split("\n")[0], named.nightly.split("\n")[0], named.row.annotationMembersOnly]).toEqual(["Rose At The Hut", "Rose At The Hut", false]);
  });
});

/**
 * Places, dates and sayings around a name, when deciding what everyone may read: the share guard for anybody who
 * may not be named, and show to everyone while a withdrawal waits out its fortnight, judge them alike. A name that is
 * part of a place's name, a date or a saying is shared as written; a real mention is refused by the guard, and taken
 * out (or held) by the withdrawal.
 */
describe("the share guard and a withdrawn naming, around places, dates and sayings", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const record = (text: string): StoredAnnotation => ({ title: text, caption: text, description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "" });

  /** [their name, the helper's words, whether the words are a place, a date or a saying rather than them] */
  const ROWS: [string, string, boolean][] = [
    ["Louise Smith", "Lake Louise at dawn", true],
    ["Louise Smith", "LAKE LOUISE AT DAWN", true],
    ["Paris Jones", "The Eiffel Tower, Paris", true],
    ["Brooklyn Jones", "Walking the Brooklyn Bridge", true],
    ["Jordan Lee", "Crossing the Jordan River", true],
    ["Madison Kemp", "Madison Square Garden", true],
    ["Harbor Lee", "Mount Harbor from the ferry", true],
    ["May Smith", "Lake day in May.", true],
    ["May Smith", "May 2019 at the lake", true],
    ["Will Turner", "Will you look at that!", true],
    ["Ruth Baker", "The Baker Street bakery", true],
    ["Louise Smith", "Louise at the lake", false],
    ["Paris Jones", "Paris blows out the candles", false],
    ["Louise Park", "Louise Park at the lake", false],
    ["Jordan Lee", "Grandpa Jordan River walk", false],
  ];

  it.each(ROWS)("%s: %s", async (name, text, notThem) => {
    const person = await db.person.create({ data: { name, optedOutAt: new Date(), createdById: admin } });
    const refused = await namesSomebodyRestricted([text]);
    await db.person.update({ where: { id: person.id }, data: { optedOutAt: null, namingWithdrawnAt: new Date() } });
    const p = await db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", title: text, titleByHelper: true, annotation: record(text), annotatedAt: new Date() } });
    const shown = await withoutWithdrawnNames(p.id, { annotation: record(text), title: text });
    const first = name.split(" ")[0];
    const words = [shown.title, (shown.annotation as StoredAnnotation).title, (shown.annotation as StoredAnnotation).caption];
    if (notThem) expect({ refused, hold: shown.hold, words }).toEqual({ refused: false, hold: false, words: [text, text, text] });
    else expect({ refused, published: shown.hold ? [] : words.filter((w) => new RegExp(first, "i").test(w ?? "")) }).toEqual({ refused: true, published: [] });
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
    ["May Lee", "A swim in May.", "A swim in May."],
    ["May Lee", "May Day at the fair.", "May Day at the fair."],
    ["Will Turner", "Will swam faster than Ben.", "A family member swam faster than Ben."],
    ["Will Turner", "Will you look at that!", "Will you look at that!"],
    ["Will Turner", "Will be fun.", "Will be fun."],
    ["Ada Byron", "Little Sister Ada and Big Brother Ada.", "A family member and a family member."],
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
