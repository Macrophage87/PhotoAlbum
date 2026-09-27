import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { forgetPerson } from "@/lib/people/forget-person";
import { looseMatcher, memberTextMentioning, scrubWithdrawnNames, withoutWithdrawnNames } from "@/lib/people/forget";
import { nameMatcher } from "@/lib/people/scrub";
import type { LeftoverItems } from "@/lib/people/forget";
import type { StoredAnnotation } from "@/lib/annotation/schema";

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

  it("the withdrawn-name scrub, and showing text to everyone, leave it alone too", async () => {
    const f = await fixture();
    await db.person.update({ where: { id: f.person.id }, data: { namingWithdrawnAt: new Date(Date.now() - 30 * 86_400_000) } });
    const shown = await withoutWithdrawnNames(f.helpers.id, { annotation: helper, title: PIER });
    expect(shown.changed).toBe(false);
    await scrubWithdrawnNames();
    expect((await db.photo.findUniqueOrThrow({ where: { id: f.helpers.id } })).annotation).toEqual(helper);
    expect((await db.trip.findUniqueOrThrow({ where: { id: f.trip.id } })).description).toBe(`${PIER} At Sunset`);
    expect((await db.photo.findUniqueOrThrow({ where: { id: f.hers.id } })).title).toBe("A Family Member At The Lake");
  });

  it("the queue's file names and the typed fields' matcher leave it alone", () => {
    const loose = looseMatcher(nameMatcher([name], []));
    for (const t of [PIER, `${PIER}.jpg`, `${PIER} Walk.gpx`, JSON.stringify({ albums: [PIER] }), `Met at the ${PIER}`]) expect([t, loose(t)]).toEqual([t, false]);
  });
});
