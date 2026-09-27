import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Viewer } from "@/lib/auth/viewer";

const who = vi.hoisted(() => ({ viewer: null as unknown as Viewer }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => who.viewer }));

import { GET as tripGeojson } from "@/app/api/trips/[slug]/geojson/route";
import { GET as mapGeojson } from "@/app/api/map/geojson/route";
import { GET as tripPhotos } from "@/app/api/trips/[slug]/photos/route";
import { db } from "@/lib/db";
import { shareKey } from "@/lib/auth/access";
import { parseGalleryFilter } from "@/lib/photos/filters";
import { timelineCounts, timelineIds as idsForTimeline, tripTimeline } from "@/lib/timeline/queries";
import { collectionTimeline } from "@/lib/collections/timeline";
import { resetTestDb } from "../helpers/reset";

const anon = (tokens: [string, string][] = []): Viewer => ({ kind: "anonymous", user: null, shareTokens: new Map(tokens) });
let member: Viewer;

const timelineIds = (r: { groups: { items: { photos: { id: string }[] }[] }[] }) => r.groups.flatMap((g) => g.items.flatMap((i) => i.photos.map((p) => p.id)));
const featureIds = async (res: Response) => ((await res.json()).photos.points as [string][]).map((p) => p[0]);
const photoIds = async (res: Response) => ((await res.json()).photos as { id: string }[]).map((p) => p.id);

/**
 * Names and members' notes are for members. A visitor who can open a public trip, collection or map, or holds a
 * link, must not be able to learn which photographs somebody is in by typing their name as a search (#142).
 */
describe("a visitor's words never match names or notes", () => {
  let tripId: string, linkTripId: string, noteTripId: string, collectionId: string, faced: string, noted: string, notedPublic: string;
  beforeAll(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "n@example.com", name: "N", role: "MEMBER" } });
    member = { kind: "user", user: { id: user.id, email: user.email, name: user.name, role: "MEMBER" }, shareTokens: new Map() };
    const dates = { startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id };
    tripId = (await db.trip.create({ data: { slug: "pub", title: "Public trip", visibility: "PUBLIC", ...dates } })).id;
    linkTripId = (await db.trip.create({ data: { slug: "link", title: "Linked trip", visibility: "LINK", shareToken: "tok", ...dates } })).id;
    const base = { uploaderId: user.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, lat: 44.3, lng: -68.2, takenAt: new Date("2025-08-11T12:00:00Z") };
    // The name only on a confirmed face: never in a caption, title or note.
    faced = (await db.photo.create({ data: { ...base, tripId, caption: "Lunch by the water" } })).id;
    const marguerite = await db.person.create({ data: { name: "Marguerite Hastings", birthday: new Date("1970-01-01"), createdById: user.id } });
    await db.face.create({ data: { photoId: faced, personId: marguerite.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0.9 } });
    await db.photo.update({ where: { id: faced }, data: { updatedAt: new Date() } });
    // The name only in the uploader's members-only notes, with nobody tagged.
    noted = (await db.photo.create({ data: { ...base, tripId: linkTripId, caption: "Cake", context: "Marguerite's birthday" } })).id;
    // The same name only in the notes of a photograph on a public trip, which any visitor may open.
    noteTripId = (await db.trip.create({ data: { slug: "pubnote", title: "Public trip with a note", visibility: "PUBLIC", ...dates } })).id;
    notedPublic = (await db.photo.create({ data: { ...base, tripId: noteTripId, caption: "Candles", context: "Marguerite's birthday" } })).id;
    const collection = await db.collection.create({ data: { slug: "pubc", title: "Public collection", visibility: "PUBLIC", createdById: user.id } });
    collectionId = collection.id;
    await db.collectionItem.create({ data: { collectionId, photoId: faced, addedById: user.id } });
  });

  it("on a trip's timeline", async () => {
    expect(timelineIds(await tripTimeline(tripId, "UTC", parseGalleryFilter({ q: "Marguerite" }, { member: false, inTrip: true })))).toEqual([]);
    expect(timelineIds(await tripTimeline(tripId, "UTC", parseGalleryFilter({ q: "Marguerite" }, { member: true, inTrip: true })))).toEqual([faced]);
  });

  it("on a collection's timeline", async () => {
    expect(timelineIds(await collectionTimeline(collectionId, parseGalleryFilter({ q: "Marguerite" }, { member: false })))).toEqual([]);
    expect(timelineIds(await collectionTimeline(collectionId, parseGalleryFilter({ q: "Marguerite" }, { member: true })))).toEqual([faced]);
  });

  it("on a trip's map", async () => {
    const ask = () => tripGeojson(new Request("http://album.test/api/trips/pub/geojson?q=Marguerite"), { params: Promise.resolve({ slug: "pub" }) });
    who.viewer = anon();
    expect(await featureIds(await ask())).toEqual([]);
    who.viewer = member;
    expect(await featureIds(await ask())).toEqual([faced]);
  });

  it("on the album's map", async () => {
    const ask = () => mapGeojson(new Request("http://album.test/api/map/geojson?q=Marguerite"));
    who.viewer = anon();
    expect(await featureIds(await ask())).toEqual([]);
    who.viewer = member;
    expect(await featureIds(await ask())).toContain(faced);
  });

  it("in a note: a link holder or a visitor finds nothing by the name in it, and a member finds the photograph", async () => {
    const ask = (slug: string) => tripPhotos(new NextRequest(`http://album.test/api/trips/${slug}/photos?q=Marguerite`), { params: Promise.resolve({ slug }) } as never);
    who.viewer = anon([[shareKey("trip", linkTripId), "tok"]]);
    expect(await photoIds(await ask("link"))).toEqual([]);
    // And a visitor on the public trip, where the tagged one is, finds nothing either.
    who.viewer = anon();
    expect(await photoIds(await ask("pub"))).toEqual([]);
    who.viewer = member;
    expect(await photoIds(await ask("link"))).toEqual([noted]);
    expect(await photoIds(await ask("pub"))).toEqual([faced]);
  });

  it("in a note on a public trip: a visitor finds nothing by the name on its gallery, its timeline, the timeline of everything or the maps", async () => {
    const gallery = (q: string) => tripPhotos(new NextRequest(`http://album.test/api/trips/pubnote/photos?q=${q}`), { params: Promise.resolve({ slug: "pubnote" }) } as never);
    const tripMap = () => tripGeojson(new Request("http://album.test/api/trips/pubnote/geojson?q=Marguerite"), { params: Promise.resolve({ slug: "pubnote" }) });
    const albumMap = () => mapGeojson(new Request("http://album.test/api/map/geojson?q=Marguerite"));
    const inTrip = (q: string, m: boolean) => parseGalleryFilter({ q }, { member: m, inTrip: true });
    const album = (q: string, m: boolean) => parseGalleryFilter({ q }, { member: m });
    // The timeline of everything asks the words once of the whole album, then counts and draws each trip from that.
    const everything = async (q: string, m: boolean) => {
      const restrict = await idsForTimeline(album(q, m), null);
      const counts = await timelineCounts([noteTripId], album(q, m), restrict);
      return { count: counts.get(noteTripId) ?? 0, ids: timelineIds(await tripTimeline(noteTripId, "UTC", album(q, m), restrict)) };
    };

    who.viewer = anon();
    // Its public words find it, so what follows is asked of a photograph this visitor can see.
    expect(await photoIds(await gallery("Candles"))).toEqual([notedPublic]);
    expect(await everything("Candles", false)).toEqual({ count: 1, ids: [notedPublic] });
    expect(await photoIds(await gallery("Marguerite"))).toEqual([]);
    expect(timelineIds(await tripTimeline(noteTripId, "UTC", inTrip("Marguerite", false)))).toEqual([]);
    expect(await everything("Marguerite", false)).toEqual({ count: 0, ids: [] });
    expect(await featureIds(await tripMap())).toEqual([]);
    expect(await featureIds(await albumMap())).toEqual([]);

    // A member reads the notes, and finds it everywhere.
    who.viewer = member;
    expect(await photoIds(await gallery("Marguerite"))).toEqual([notedPublic]);
    expect(timelineIds(await tripTimeline(noteTripId, "UTC", inTrip("Marguerite", true)))).toEqual([notedPublic]);
    expect(await everything("Marguerite", true)).toEqual({ count: 1, ids: [notedPublic] });
    expect(await featureIds(await tripMap())).toEqual([notedPublic]);
    expect(await featureIds(await albumMap())).toContain(notedPublic);
  });
});
