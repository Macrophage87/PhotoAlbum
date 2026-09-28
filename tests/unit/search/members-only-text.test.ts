import { beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { searchMedia } from "@/lib/search/query";
import { idsMatching } from "@/lib/photos/page";
import { applyAnnotation } from "@/lib/annotation/apply";
import { annotationSchema } from "@/lib/annotation/schema";
import { buildCollectionMapPayload, buildMapPayload } from "@/lib/map/geojson";
import { describeMapPhotos } from "@/lib/map/details";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { tripPhotoPage } from "@/lib/photos/page";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
let member: Viewer;

const record = (over: Partial<Record<string, unknown>> = {}) =>
  annotationSchema.parse({
    title: "Ada and Ben on the porch",
    caption: "Ada and Ben with their coffee on the back porch",
    description: "Ada and Ben share a pot of coffee on the porch of the cottage at 12 Elm Street.",
    tags: ["porch", "coffee", "morning"],
    place: null,
    activity: "drinking coffee",
    objects: ["mug"],
    visibleText: null,
    season: "summer",
    mood: "relaxed",
    searchSummary: "Ada and Ben, porch, coffee, morning, cottage",
    estimatedYear: null,
    estimatedPlace: null,
    ...over,
  });

/**
 * What strangers may read and search of a photograph: never the uploader's notes, never a name, and never the
 * helper's text where it was written from either — on the search page, in a gallery's or a map's word search, in the
 * lightbox and on the map's legend.
 */
describe("text a stranger may read and search", () => {
  let dana: string, publicTrip: string, privateTrip: string, named: string, plain: string, noted: string, fromPrivate: string;

  beforeAll(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } });
    dana = user.id;
    member = { kind: "user", user: { id: dana, email: user.email, name: user.name, role: "MEMBER" }, shareTokens: new Map() };
    publicTrip = (await db.trip.create({ data: { slug: "cottage", title: "Cottage week", startDate: new Date("2025-07-01"), endDate: new Date("2025-07-08"), visibility: "PUBLIC", createdById: dana } })).id;
    privateTrip = (await db.trip.create({ data: { slug: "hospital", title: "Hopkins weekend", startDate: new Date("2025-03-01"), endDate: new Date("2025-03-03"), createdById: dana } })).id;
    const photo = (data: Record<string, unknown>) => db.photo.create({ data: { originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", uploaderId: dana, ...data } });
    named = (await photo({ tripId: publicTrip, lat: 44.1, lng: -68.1 })).id;
    plain = (await photo({ tripId: publicTrip, lat: 44.2, lng: -68.2 })).id;
    noted = (await photo({ tripId: publicTrip, context: "Grandma's house, the key is under the mat", lat: 44.3, lng: -68.3 })).id;
    // A photograph from a private trip, shown to the world only through a public collection.
    const activity = await db.activity.create({ data: { tripId: privateTrip, title: "Chemo, second round", startTime: new Date("2025-03-01T10:00:00Z"), endTime: new Date("2025-03-01T16:00:00Z") } });
    fromPrivate = (await photo({ tripId: privateTrip, activityId: activity.id, caption: "Waiting room view", lat: 39.3, lng: -76.6 })).id;
    const col = await db.collection.create({ data: { slug: "views", title: "Views", visibility: "PUBLIC", createdById: dana } });
    await db.collectionItem.create({ data: { collectionId: col.id, photoId: fromPrivate, addedById: dana } });

    // Ada is confirmed on one photograph; the helper is then given her name and uses it.
    const ada = await db.person.create({ data: { name: "Ada", nameInDescriptions: true, adultAttestedAt: new Date(), createdById: dana } });
    await db.face.create({ data: { photoId: named, personId: ada.id, box: {}, confidence: 0.99, status: "CONFIRMED" } });
    await applyAnnotation(named, "m", record(), {});
    // Nobody tagged, no notes, no name: the helper's words are anybody's.
    await applyAnnotation(plain, "m", record({ title: "Lighthouse at dusk", caption: "The lighthouse at dusk", description: "The lighthouse against a pink sky.", searchSummary: "lighthouse, dusk, sunset", tags: ["lighthouse"] }), {});
    // Written from the notes, which strangers never read.
    await applyAnnotation(noted, "m", record({ title: "Grandma's porch", caption: "Grandma's porch", description: "The porch at Grandma's house; the key is kept under the mat.", searchSummary: "porch, key, mat", tags: ["porch"] }), {});
  });

  it("keeps the helper's title that names somebody off the photograph, for members to read in its place", async () => {
    const p = await db.photo.findUniqueOrThrow({ where: { id: named } });
    expect(p.annotationMembersOnly).toBe(true);
    expect(p.title).toBeNull();
    expect(p.membersTitle).toBe("Ada and Ben on the porch");
    const q = await db.photo.findUniqueOrThrow({ where: { id: plain } });
    expect([q.annotationMembersOnly, q.title, q.membersTitle]).toEqual([false, "Lighthouse at dusk", null]);
    expect((await db.photo.findUniqueOrThrow({ where: { id: noted } })).annotationMembersOnly).toBe(true);
  });

  it("never matches a stranger's search on a name, on notes, or on the helper's text written from them", async () => {
    expect(await searchMedia(anon, { q: "Ada" }, 120, null)).toEqual([]);
    expect(await searchMedia(anon, { q: "Dana" }, 120, null)).toEqual([]);
    expect(await searchMedia(anon, { q: "mat" }, 120, null)).toEqual([]);
    expect(await searchMedia(anon, { q: "elm" }, 120, null)).toEqual([]);
    expect((await searchMedia(anon, { q: "lighthouse" }, 120, null)).map((h) => h.id)).toEqual([plain]);
    // Members find all of it, and read the helper's title where the photograph has none of its own.
    const ada = await searchMedia(member, { q: "Ada" }, 120, null);
    expect(ada.map((h) => h.id)).toEqual([named]);
    expect(ada[0].title).toBe("Ada and Ben on the porch");
    expect((await searchMedia(member, { q: "mat" }, 120, null)).map((h) => h.id)).toEqual([noted]);
  });

  it("never shows a stranger the notes in a snippet", async () => {
    // The caption matches, and the notes beside it would have been the rest of the snippet.
    await db.photo.update({ where: { id: noted }, data: { caption: "Front steps in the snow" } });
    const [hit] = await searchMedia(anon, { q: "snow" }, 120, null);
    expect(hit.id).toBe(noted);
    expect(hit.snippet).not.toMatch(/mat|key|Grandma/i);
    const [mine] = await searchMedia(member, { q: "key" }, 120, null);
    expect(mine.snippet).toContain("[[key]]");
  });

  it("does not ask the semantic index a stranger's question, since it is built from the notes and names too", async () => {
    const embed = vi.fn(async () => null);
    await searchMedia(anon, { q: "coffee" }, 120, embed);
    expect(embed).not.toHaveBeenCalled();
    await searchMedia(member, { q: "coffee" }, 120, embed);
    expect(embed).toHaveBeenCalledOnce();
  });

  it("does not let a stranger pick out a private trip's photographs by a word from its title", async () => {
    expect(await searchMedia(anon, { q: "Hopkins" }, 120, null)).toEqual([]);
    expect((await searchMedia(member, { q: "Hopkins" }, 120, null)).map((h) => h.id)).toEqual([fromPrivate]);
    // Once the trip is public its title is anybody's to search, and going private again takes it back.
    await db.trip.update({ where: { id: privateTrip }, data: { visibility: "PUBLIC" } });
    expect((await searchMedia(anon, { q: "Hopkins" }, 120, null)).map((h) => h.id)).toEqual([fromPrivate]);
    await db.trip.update({ where: { id: privateTrip }, data: { visibility: "PRIVATE" } });
    expect(await searchMedia(anon, { q: "Hopkins" }, 120, null)).toEqual([]);
  });

  it("narrows a public trip's gallery and map by what a stranger may read, never by a name", async () => {
    const stranger = parseGalleryFilter({ q: "Ada" }, { member: false });
    expect((await tripPhotoPage(publicTrip, { filter: stranger })).total).toBe(0);
    expect((await buildMapPayload(anon, publicTrip, stranger)).photos.points).toEqual([]);
    expect((await buildMapPayload(anon, undefined, stranger)).photos.points).toEqual([]);
    expect((await buildMapPayload(anon, publicTrip, parseGalleryFilter({ q: "Dana" }, { member: false }))).photos.points).toEqual([]);
    // A filter that claims to be a member's is still a stranger's when a stranger is asking.
    expect((await buildMapPayload(anon, publicTrip, parseGalleryFilter({ q: "Ada" }, { member: true }))).photos.points).toEqual([]);
    const family = parseGalleryFilter({ q: "Ada" }, { member: true });
    expect((await tripPhotoPage(publicTrip, { filter: family })).photos.map((p) => p.id)).toEqual([named]);
    expect((await buildMapPayload(member, publicTrip, family)).photos.points.map((p) => p[0])).toEqual([named]);
  });

  it("asks the words inside the trip, so matches elsewhere cannot crowd out the trip's own", async () => {
    // Both match "porch"; only one is on this trip. With room for a single match the trip's must still be the one.
    const elsewhere = await db.photo.create({ data: { originalName: "porch porch porch.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", uploaderId: dana, caption: "Porch, porch and more porch" } });
    expect(await idsMatching("porch", { member: true, limit: 1, scope: { tripId: publicTrip } })).toHaveLength(1);
    expect(await idsMatching("porch", { member: true, limit: 5, scope: { tripId: publicTrip } })).not.toContain(elsewhere.id);
    expect(await idsMatching("porch", { member: true, limit: 5, scope: { tripId: null } })).toEqual([elsewhere.id]);
    // And the same words, asked twice, keep the same ones when they have to choose.
    expect(await idsMatching("porch", { member: true, limit: 2 })).toEqual(await idsMatching("porch", { member: true, limit: 2 }));
  });

  it("names neither the private trip nor its activity on a map a stranger sees the photograph on", async () => {
    // Not when it is clicked…
    const [anyone] = await describeMapPhotos(anon, [fromPrivate], null);
    expect(anyone).toMatchObject({ caption: "Waiting room view", trip: null, activityTitle: null, uploadedBy: null });
    // …and not in the legend of either map it is on, where its activity could otherwise be something to colour by.
    const everywhere = await buildMapPayload(anon);
    expect(everywhere.photos.points.map((p) => p[0])).toContain(fromPrivate);
    const onCollection = await buildCollectionMapPayload(anon, (await db.collection.findFirstOrThrow()).id);
    for (const payload of [everywhere, onCollection]) expect(JSON.stringify(payload)).not.toMatch(/Chemo|Hopkins/);
    const [family] = await describeMapPhotos(member, [fromPrivate], null);
    expect(family).toMatchObject({ trip: { slug: "hospital", title: "Hopkins weekend" }, activityTitle: "Chemo, second round", uploadedBy: "Dana" });
    expect((await buildMapPayload(member)).rings.activity.groups.map((g) => g.label)).toContain("Chemo, second round");
  });
});
