import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { buildCollectionMapPayload, buildCollectionMapView, buildMapPayload, buildMapView, type MapPhotos } from "@/lib/map/geojson";
import { gridCells, inViewport, MAX_CELLS, mercator, parseViewport, POINT_LIMIT } from "@/lib/map/view";
import { NO_FILTER } from "@/lib/photos/filters";
import { BUILD_GIVE_UP_MS, forgetMapStates, MAP_STATE_TTL_MS, REBUILD_EVERY_MS } from "@/lib/map/cache";
import { JITTER_STEP_M, spreadOverlapping } from "@/lib/map/jitter";
import { haversine } from "@/lib/geo/haversine";
import type { Viewer } from "@/lib/auth/viewer";
import { shareKey } from "@/lib/auth/access";
import { resetTestDb } from "../helpers/reset";

// A map is sent a view at a time past fifty photographs here, rather than past fifteen hundred: the same behaviour,
// from a few dozen rows rather than a few thousand.
vi.mock("@/lib/map/view", async (original) => ({ ...(await original<typeof import("@/lib/map/view")>()), POINT_LIMIT: 50 }));

const member: Viewer = { kind: "user", user: { id: "u", email: "m@example.com", name: null, role: "MEMBER" }, shareTokens: new Map() };
const stranger: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
const idsOf = (photos: MapPhotos) => photos.points.map((p) => p[0]);

describe("pins on the same spot", () => {
  const at = (id: string, lat: number, lng: number) => ({ id, lat, lng });

  it("leaves a spot with one photo exactly where it is", () => {
    const one = [at("a", 44.35, -68.2), at("b", 44.4, -68.3)];
    expect(spreadOverlapping(one)).toEqual(one);
  });

  it("fans a stack out far enough to click, close enough to still read as one place", () => {
    const stack = Array.from({ length: 6 }, (_, i) => at(`p${i}`, 39.4015, -76.6019));
    const spread = spreadOverlapping(stack);
    // The first keeps the true position; the others move, and no two land on each other.
    expect(spread[0]).toEqual(stack[0]);
    const seen = new Set(spread.map((p) => `${p.lat},${p.lng}`));
    expect(seen.size).toBe(6);
    for (const p of spread) {
      const m = haversine(39.4015, -76.6019, p.lat, p.lng);
      expect(m).toBeLessThan(JITTER_STEP_M * 4);
    }
    // Spreading twice gives the same answer, so a pin does not wander between page loads.
    expect(spreadOverlapping(stack)).toEqual(spread);
    // …whatever order they arrive in.
    expect(spreadOverlapping([...stack].reverse()).find((p) => p.id === "p3")).toEqual(spread.find((p) => p.id === "p3"));
  });

  it("keeps photos at different spots apart from each other's stacks", () => {
    const mixed = [at("a", 10, 10), at("b", 10, 10), at("c", 20, 20)];
    const spread = spreadOverlapping(mixed);
    expect(spread.find((p) => p.id === "c")).toEqual(at("c", 20, 20));
  });

  it("does not divide by nothing at the poles", () => {
    const polar = [at("a", 89.999, 0), at("b", 89.999, 0)];
    for (const p of spreadOverlapping(polar)) {
      expect(Number.isFinite(p.lat)).toBe(true);
      expect(Number.isFinite(p.lng)).toBe(true);
    }
  });
});

describe("the map across everything", () => {
  let onTrip: string, noTrip: string, collectionOnly: string, collectionId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "PRIVATE" } });
    const base = { uploaderId: user.id, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, gpsSource: "EXIF" as const };
    onTrip = (await db.photo.create({ data: { ...base, tripId: trip.id, originalName: "trip.jpg", lat: 44.35, lng: -68.2 } })).id;
    noTrip = (await db.photo.create({ data: { ...base, originalName: "loose.jpg", lat: 41.9, lng: 12.45 } })).id;
    collectionOnly = (await db.photo.create({ data: { ...base, originalName: "collected.jpg", lat: 39.28, lng: -76.61 } })).id;
    const collection = await db.collection.create({ data: { slug: "c", title: "C", createdById: user.id, visibility: "PUBLIC" } });
    collectionId = collection.id;
    await db.collectionItem.create({ data: { collectionId, photoId: collectionOnly, addedById: user.id } });
  });

  it("shows a member every placed photo, including ones on no trip at all", async () => {
    const ids = idsOf((await buildMapPayload(member)).photos);
    expect(ids.sort()).toEqual([onTrip, noTrip, collectionOnly].sort());
  });

  it("still bounds the map around photos that belong to no trip", async () => {
    const payload = await buildMapPayload(member);
    expect(payload.bounds).not.toBeNull();
    const [[minLng], [maxLng]] = payload.bounds!;
    expect(minLng).toBeLessThanOrEqual(-76.61);
    expect(maxLng).toBeGreaterThanOrEqual(12.45);
  });

  it("shows a visitor what a public collection holds, without naming the private trip", async () => {
    const payload = await buildMapPayload(stranger);
    expect(idsOf(payload.photos)).toEqual([collectionOnly]);
    expect(payload.trips).toEqual([]);
  });

  it("keeps one trip's map to that trip", async () => {
    const trip = await db.trip.findFirstOrThrow();
    expect(idsOf((await buildMapPayload(member, trip.id)).photos)).toEqual([onTrip]);
  });

  it("spreads a stack on a collection's map too", async () => {
    const user = await db.user.findFirstOrThrow();
    const twin = await db.photo.create({ data: { uploaderId: user.id, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", gpsSource: "MANUAL", originalName: "twin.jpg", lat: 39.28, lng: -76.61 } });
    await db.collectionItem.create({ data: { collectionId, photoId: twin.id, addedById: user.id } });
    const points = (await buildCollectionMapPayload(member, collectionId)).photos.points;
    expect(points).toHaveLength(2);
    expect(points[0].slice(1, 3)).not.toEqual(points[1].slice(1, 3));
  });
});

describe("what a map sends of each photograph", () => {
  let uploaderId: string, tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "m@example.com", name: "Grandma Jo", role: "ADMIN" } });
    uploaderId = user.id;
    tripId = (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "PUBLIC" } })).id;
    await db.photo.create({ data: { uploaderId, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", gpsSource: "EXIF", originalName: "a.jpg", caption: "Jo at the lighthouse", lat: 44.35, lng: -68.2, takenAt: new Date("2025-08-12T15:00:00Z"), tzOffsetMin: -240 } });
  });

  it("sends where and when and the ring slots, and nothing a caption or a name could be read from", async () => {
    const payload = await buildMapPayload(member, tripId);
    expect(payload.total).toBe(1);
    const [point] = payload.photos.points;
    expect(point).toHaveLength(7);
    expect(point.slice(1, 4)).toEqual([-68.2, 44.35, "2025-08-12"]);
    expect(JSON.stringify(payload.photos)).not.toMatch(/lighthouse|Grandma|\/api\/photos/);
    // A member may colour by who uploaded: the legend names them, the photograph carries only a slot.
    expect(payload.rings.uploader!.groups.map((g) => g.label)).toEqual(["Grandma Jo"]);
    expect(point[6]).toBe(payload.rings.uploader!.groups[0].slot);
  });

  it("gives a visitor no way to colour by who uploaded, not even a key", async () => {
    const payload = await buildMapPayload(stranger, tripId);
    expect(payload.photos.points[0][6]).toBeNull();
    expect(payload.rings.uploader).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("Grandma");
    expect(JSON.stringify(payload)).not.toContain(uploaderId);
  });
});

describe("a map bigger than one answer", () => {
  let tripId: string, collectionId: string;
  const count = POINT_LIMIT + 300;
  // Seeded once: nearly two thousand photographs take seconds to write, and nothing here changes them.
  beforeAll(async () => {
    await resetTestDb();
    const user = await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } });
    tripId = (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "PRIVATE" } })).id;
    // Most in one town, a few far away.
    await db.photo.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        uploaderId: user.id, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, gpsSource: "EXIF" as const, originalName: `${i}.jpg`,
        lat: i < 10 ? 10 + i : 44.3 + (i % 50) * 0.001, lng: i < 10 ? 10 + i : -68.2 + Math.floor(i / 50) * 0.001, takenAt: new Date(Date.UTC(2025, 7, 10 + (i % 5))),
      })),
    });
    collectionId = (await db.collection.create({ data: { slug: "c", title: "C", createdById: user.id, visibility: "PUBLIC" } })).id;
    const photos = await db.photo.findMany({ select: { id: true } });
    await db.collectionItem.createMany({ data: photos.map((p) => ({ collectionId, photoId: p.id, addedById: user.id })) });
  }, 60_000);

  it("sends no photographs up front, but says how many there are and how to colour them all", async () => {
    const payload = await buildMapPayload(member, tripId);
    expect(payload.photos).toEqual({ points: [], cells: [], complete: false, version: payload.version });
    expect(payload.total).toBe(count);
    expect(payload.rings.day.groups.reduce((n, g) => n + g.count, 0)).toBe(count);
    expect(payload.bounds).not.toBeNull();
  }, 30_000);

  it("groups a crowded view into cells that count every photograph in it, coloured as the whole map is", async () => {
    const view = { west: -180, south: -85, east: 180, north: 85, zoom: 2 };
    const answer = await buildMapView(member, tripId, NO_FILTER, view);
    expect(answer.version).toBe((await buildMapPayload(member, tripId)).version);
    expect(answer.cells.length).toBeGreaterThan(0);
    expect(answer.cells.length + answer.points.length).toBeLessThan(50);
    // Nothing is left out: every photograph is in a cell or is sent as itself.
    expect(answer.cells.reduce((n, c) => n + c.n, 0) + answer.points.length).toBe(count);
    for (const c of answer.cells) {
      const days = c.rings.day.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0);
      expect(days).toBe(c.n);
      expect(c.box[0]).toBeLessThanOrEqual(c.at[0]);
      expect(c.box[2]).toBeGreaterThanOrEqual(c.at[0]);
    }
  }, 30_000);

  it("sends the photographs one by one once the view holds few enough of them", async () => {
    const far = await buildMapView(member, tripId, NO_FILTER, { west: 9, south: 9, east: 20, north: 20, zoom: 6 });
    expect(far.cells).toEqual([]);
    expect(far.points).toHaveLength(10);
    // In the order they were taken, like the whole map.
    const days = far.points.map((p) => p[3]!);
    expect([...days].sort()).toEqual(days);
  }, 30_000);

  it("answers the same way for a collection's map", async () => {
    expect((await buildCollectionMapPayload(stranger, collectionId)).photos.complete).toBe(false);
    const answer = await buildCollectionMapView(stranger, collectionId, NO_FILTER, { west: -180, south: -85, east: 180, north: 85, zoom: 2 });
    expect(answer.cells.reduce((n, c) => n + c.n, 0) + answer.points.length).toBe(count);
    expect(answer.cells.every((c) => c.rings.uploader === null)).toBe(true);
  }, 30_000);
});

/** Every photograph an answer accounts for, one by one or in its cells. */
const countOf = (photos: MapPhotos) => photos.points.length + photos.cells.reduce((n, c) => n + c.n, 0);
const everywhere = { west: -180, south: -85, east: 180, north: 85, zoom: 2 };
/** A few hundred metres round a spot, zoomed in far enough for single photographs. */
const near = (lat: number, lng: number) => ({ west: lng - 0.01, south: lat - 0.01, east: lng + 0.01, north: lat + 0.01, zoom: 15 });
/** More photographs than one answer holds (POINT_LIMIT is 50 in this file), so the map is one worth keeping. */
const MANY = 60;

describe("a map kept from one view to the next", () => {
  let tripId: string, photoId: string, uploaderId: string;
  beforeEach(async () => {
    await resetTestDb();
    forgetMapStates();
    uploaderId = (await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: uploaderId, visibility: "PUBLIC" } })).id;
    const base = { uploaderId, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, gpsSource: "EXIF" as const };
    photoId = (await db.photo.create({ data: { ...base, originalName: "a.jpg", lat: 44.35, lng: -68.2, takenAt: new Date("2025-08-12T15:00:00Z") } })).id;
    await db.photo.createMany({ data: Array.from({ length: MANY - 1 }, (_, i) => ({ ...base, originalName: `${i}.jpg`, lat: 44.36 + i * 0.0001, lng: -68.21, takenAt: new Date("2025-08-12T16:00:00Z") })) });
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers a view from the map already worked out, without reading every photograph again", async () => {
    await buildMapPayload(stranger);
    const read = vi.spyOn(db.photo, "findMany");
    expect(countOf(await buildMapView(stranger, undefined, NO_FILTER, everywhere))).toBe(MANY);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not keep a map small enough to send whole", async () => {
    await db.photo.deleteMany({ where: { id: { not: photoId } } });
    await buildMapPayload(stranger);
    const read = vi.spyOn(db.photo, "findMany");
    expect((await buildMapPayload(stranger)).photos.points.map((p) => p[0])).toEqual([photoId]);
    expect(read).toHaveBeenCalled();
  });

  it("stops showing a visitor a trip the moment it is made private", async () => {
    expect(countOf(await buildMapView(stranger, undefined, NO_FILTER, everywhere))).toBe(MANY);
    await db.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE" } });
    expect(countOf(await buildMapView(stranger, undefined, NO_FILTER, everywhere))).toBe(0);
  });

  it("drops a photograph in the trash from the very next view, for a member too", async () => {
    await buildMapView(member, undefined, NO_FILTER, everywhere);
    await db.photo.update({ where: { id: photoId }, data: { trashedAt: new Date(), trashedById: uploaderId, trashReason: "BLURRY" } });
    expect(idsOf(await buildMapView(member, undefined, NO_FILTER, near(44.35, -68.2)))).not.toContain(photoId);
  });

  /** A photograph on the trip with no place yet: a first place is only something more to see. */
  const unplacedPhoto = async (originalName = "u.jpg") =>
    (await db.photo.create({ data: { uploaderId, tripId, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", gpsSource: "EXIF", originalName, takenAt: new Date("2025-08-14T12:00:00Z") } })).id;

  it("answers anybody from the kept map while a first place is worked in, once, unless asked for it fresh", async () => {
    const unplaced = await unplacedPhoto();
    const before = await buildMapView(member, undefined, NO_FILTER, everywhere);
    await buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await db.photo.update({ where: { id: unplaced }, data: { lat: 10, lng: 10 } });
    const read = vi.spyOn(db.photo, "findMany");
    const stale = await Promise.all([member, member, stranger, stranger].map((viewer) => buildMapView(viewer, undefined, NO_FILTER, near(10, 10))));
    for (const answer of stale) expect(idsOf(answer)).toEqual([]);
    // However many ask, each map is worked out again once.
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
    // The placing screen asks for it fresh, and sees the photograph where it was put.
    const fresh = await buildMapView(member, undefined, NO_FILTER, near(10, 10), { fresh: true });
    expect(fresh.points.find((p) => p[0] === unplaced)!.slice(1, 4)).toEqual([10, 10, "2025-08-14"]);
    // A new day in the legend: the map is told its legends are not the ones these slots are numbered by.
    expect(fresh.version).not.toBe(before.version);
    expect((await buildMapPayload(member)).version).toBe(fresh.version);
  });

  it("answers from a kept map only while it is young, to a member or a visitor", async () => {
    const [unplaced, later] = [await unplacedPhoto("u.jpg"), await unplacedPhoto("v.jpg")];
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    for (const viewer of [member, stranger]) await buildMapView(viewer, undefined, NO_FILTER, everywhere);
    await db.photo.update({ where: { id: unplaced }, data: { lat: 10, lng: 10 } });
    clock.mockReturnValue(start + MAP_STATE_TTL_MS - 1);
    for (const viewer of [member, stranger]) expect(idsOf(await buildMapView(viewer, undefined, NO_FILTER, near(10, 10)))).toEqual([]);
    // Worked out again while that was answered; forget it, so only the age of the first decides.
    forgetMapStates();
    clock.mockReturnValue(start);
    for (const viewer of [member, stranger]) await buildMapView(viewer, undefined, NO_FILTER, everywhere);
    await db.photo.update({ where: { id: later }, data: { lat: 11, lng: 11 } });
    clock.mockReturnValue(start + MAP_STATE_TTL_MS + 1);
    for (const viewer of [member, stranger]) expect(idsOf(await buildMapView(viewer, undefined, NO_FILTER, near(11, 11)))).toEqual([later]);
  });

  it("works a map out again at most every few seconds while only additions wait for it", async () => {
    const [first, second] = [await unplacedPhoto("u.jpg"), await unplacedPhoto("v.jpg")];
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await db.photo.update({ where: { id: first }, data: { lat: 10, lng: 10 } });
    const read = vi.spyOn(db.photo, "findMany");
    clock.mockReturnValue(start + 1000);
    await buildMapView(stranger, undefined, NO_FILTER, everywhere);
    // Long enough for a working-out, had one been started, to have asked for the photographs.
    await new Promise((r) => setTimeout(r, 200));
    expect(read).not.toHaveBeenCalled();
    clock.mockReturnValue(start + REBUILD_EVERY_MS + 1);
    await buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    // Let that one finish, then add again at once: answered from it, and not worked out again yet.
    await vi.waitFor(async () => expect(idsOf(await buildMapView(stranger, undefined, NO_FILTER, near(10, 10)))).toEqual([first]));
    await db.photo.update({ where: { id: second }, data: { lat: 11, lng: 11 } });
    clock.mockReturnValue(start + REBUILD_EVERY_MS + 2000);
    expect(idsOf(await buildMapView(stranger, undefined, NO_FILTER, near(11, 11)))).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shares a working-out begun since the last thing taken off, and never one begun before it", async () => {
    forgetMapStates();
    const original = db.photo.findMany.bind(db.photo);
    const read = vi.spyOn(db.photo, "findMany");
    // Nothing kept: two asking, with only an addition between them, share one working-out.
    const first = buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await db.photo.update({ where: { id: await unplacedPhoto() }, data: { lat: 10, lng: 10 } });
    const second = buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
    // A working-out that has read the photographs, and is still going when the trip is made private…
    forgetMapStates();
    let fetched!: () => void, release!: () => void;
    const hasRead = new Promise<void>((r) => (fetched = r));
    const gate = new Promise<void>((r) => (release = r));
    read.mockImplementationOnce((async (...args: Parameters<typeof original>) => {
      const rows = await original(...args);
      fetched();
      await gate;
      return rows;
    }) as never);
    const before = buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await hasRead;
    await db.trip.update({ where: { id: tripId }, data: { visibility: "PRIVATE" } });
    // …is not what the next visitor waits for: they get a map worked out after it.
    const after = buildMapView(stranger, undefined, NO_FILTER, everywhere);
    release();
    // (The photograph placed above makes one more.)
    expect(countOf(await before)).toBe(MANY + 1);
    expect(countOf(await after)).toBe(0);
  });

  it("does not wait on a working-out that has hung", async () => {
    forgetMapStates();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    vi.spyOn(db.photo, "findMany").mockImplementationOnce((() => new Promise(() => {})) as never);
    void buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await new Promise((r) => setTimeout(r, 50));
    clock.mockReturnValue(start + BUILD_GIVE_UP_MS + 1);
    expect(countOf(await buildMapView(stranger, undefined, NO_FILTER, everywhere))).toBe(MANY);
  });

  it("stops waiting on a shared working-out once it has run long enough to count as hung", async () => {
    forgetMapStates();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    vi.spyOn(db.photo, "findMany").mockImplementationOnce((() => new Promise(() => {})) as never);
    void buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await new Promise((r) => setTimeout(r, 50));
    // Asked just before the first would count as hung: shared, but only for what is left of its time.
    clock.mockReturnValue(start + BUILD_GIVE_UP_MS - 100);
    const answer = await Promise.race([buildMapView(stranger, undefined, NO_FILTER, everywhere), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    expect(answer && countOf(answer)).toBe(MANY);
  });

  it("does not work out again a map the album has not changed under, however long it is kept", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await buildMapView(stranger, undefined, NO_FILTER, everywhere);
    const read = vi.spyOn(db.photo, "findMany");
    for (const later of [MAP_STATE_TTL_MS / 2 + 1, MAP_STATE_TTL_MS + 1, 3 * MAP_STATE_TTL_MS]) {
      clock.mockReturnValue(start + later);
      expect(countOf(await buildMapView(stranger, undefined, NO_FILTER, everywhere))).toBe(MANY);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(read).not.toHaveBeenCalled();
  });

  it("says when working a map out again in the background fails, and goes on answering from the kept one", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await buildMapView(stranger, undefined, NO_FILTER, everywhere);
    await db.photo.update({ where: { id: await unplacedPhoto() }, data: { lat: 10, lng: 10 } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.photo, "findMany").mockRejectedValueOnce(new Error("database gone away"));
    clock.mockReturnValue(start + REBUILD_EVERY_MS + 1);
    expect(countOf(await buildMapView(stranger, undefined, NO_FILTER, everywhere))).toBe(MANY);
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringContaining("failed"), expect.any(Error)));
  });

  it("takes a cleared place off the map at once, for a visitor and a member", async () => {
    for (const viewer of [stranger, member]) await buildMapView(viewer, undefined, NO_FILTER, everywhere);
    // What clearing a photograph's place does (clearPhotoPlace): the home address on a public trip, taken back.
    await db.photo.update({ where: { id: photoId }, data: { lat: null, lng: null, gpsSource: null, placeName: null } });
    for (const viewer of [stranger, member]) {
      expect(idsOf(await buildMapView(viewer, undefined, NO_FILTER, near(44.35, -68.2)))).not.toContain(photoId);
      expect(countOf(await buildMapView(viewer, undefined, NO_FILTER, everywhere))).toBe(MANY - 1);
    }
  });

  it("takes a deleted track's name and bounds off a visitor's map at once", async () => {
    const track = await db.track.create({ data: { tripId, uploaderId, source: "GPX", name: "Home to the beach.gpx", startTime: new Date("2025-08-12T09:00:00Z"), endTime: new Date("2025-08-12T10:00:00Z"), pointCount: 2, minLat: 60, maxLat: 61, minLng: 60, maxLng: 61, simplified: [[60, 60], [61, 61]], pointsBlob: new Uint8Array() } });
    const before = await buildMapPayload(stranger);
    expect(JSON.stringify(before)).toContain("Home to the beach");
    expect(before.bounds![1]).toEqual([61, 61]);
    await db.track.delete({ where: { id: track.id } });
    const after = await buildMapPayload(stranger);
    expect(JSON.stringify(after)).not.toContain("Home to the beach");
    expect(after.bounds![1][1]).toBeLessThan(60);
  });

  it("shows a visitor a trip's new name at once", async () => {
    await buildMapPayload(stranger);
    await db.trip.update({ where: { id: tripId }, data: { title: "Grandma's street" } });
    await db.trip.update({ where: { id: tripId }, data: { title: "Down East" } });
    const after = await buildMapPayload(stranger);
    expect(after.trips.map((t) => t.title)).toEqual(["Down East"]);
    expect(JSON.stringify(after)).not.toContain("Grandma");
  });
});

describe("a collection's map kept for its visitors", () => {
  it("never serves a visitor without a trip's link what a visitor holding it was shown", async () => {
    await resetTestDb();
    forgetMapStates();
    const user = await db.user.create({ data: { email: "m@example.com", role: "ADMIN" } });
    const trip = await db.trip.create({ data: { slug: "linked", title: "Linked", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: user.id, visibility: "LINK", shareToken: "ttok" } });
    const activity = await db.activity.create({ data: { tripId: trip.id, title: "Secret swim", startTime: new Date("2025-08-11T10:00:00Z"), endTime: new Date("2025-08-11T12:00:00Z") } });
    // Enough of them for the map to be one that is kept.
    await db.photo.createMany({ data: Array.from({ length: MANY }, (_, i) => ({ uploaderId: user.id, tripId: trip.id, activityId: activity.id, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" as const, gpsSource: "EXIF" as const, originalName: `${i}.jpg`, lat: 44.35 + i * 0.001, lng: -68.2, takenAt: new Date("2025-08-11T11:00:00Z") })) });
    const collection = await db.collection.create({ data: { slug: "c", title: "C", createdById: user.id, visibility: "PUBLIC" } });
    await db.collectionItem.createMany({ data: (await db.photo.findMany({ select: { id: true } })).map((p) => ({ collectionId: collection.id, photoId: p.id, addedById: user.id })) });
    const activities = async (viewer: Viewer) => (await buildCollectionMapPayload(viewer, collection.id)).rings.activity.groups.map((g) => g.label);

    // Holding the trip's link, a visitor may colour this collection's map by the trip's activities…
    const holder: Viewer = { kind: "anonymous", user: null, shareTokens: new Map([[shareKey("trip", trip.id), "ttok"]]) };
    expect(await activities(holder)).toContain("Secret swim");
    // …and the next visitor, without it, is not handed the map worked out for the first.
    expect(await activities(stranger)).not.toContain("Secret swim");
    expect(JSON.stringify(await buildCollectionMapView(stranger, collection.id, NO_FILTER, everywhere))).not.toContain("Secret swim");
    expect(JSON.stringify(await buildCollectionMapPayload(stranger, collection.id))).not.toContain("Secret swim");
  });
});

describe("views and cells", () => {
  it("reads a view from the address, and refuses one that is not a view", () => {
    expect(parseViewport(new URLSearchParams(""))).toBeNull();
    expect(parseViewport(new URLSearchParams("bbox=-10,-5,10,5&zoom=3"))).toEqual({ west: -10, south: -5, east: 10, north: 5, zoom: 3 });
    expect(parseViewport(new URLSearchParams("bbox=-10,-5,10,5&zoom=99"))!).toMatchObject({ zoom: 24 });
    for (const bad of ["bbox=1,2,3&zoom=1", "bbox=-10,-5,10,5&zoom=", "bbox=,,,&zoom=3", "bbox=-10,,10,5&zoom=3", "bbox=a,b,c,d&zoom=1", "bbox=-10,-5,10,5", "zoom=3", "bbox=10,-5,-10,5&zoom=1", "bbox=-10,5,10,-5&zoom=1", "bbox=-10,-5,10,5&zoom=x"]) {
      expect(parseViewport(new URLSearchParams(bad))).toBe("bad");
    }
  });

  it("sees across the date line", () => {
    const pacific = { west: 170, south: -30, east: 190, north: 30, zoom: 4 };
    expect(inViewport(pacific, 0, -175)).toBe(true);
    expect(inViewport(pacific, 0, 175)).toBe(true);
    expect(inViewport(pacific, 0, 160)).toBe(false);
    expect(inViewport(pacific, 40, 175)).toBe(false);
  });

  it("keeps the poles in cells of their own, rather than in the next column's", () => {
    const at = (lat: number, lng: number) => {
      const [x, y] = mercator(lat, lng);
      return { lat, lng, x, y };
    };
    // At zoom 0 the South Pole under 0° and 84°N at 50°E used to be numbered as one cell, drawn in between; so did
    // the North Pole at 50°E and 84°S under 0°.
    for (const pair of [[at(-90, 0), at(84, 50)], [at(90, 50), at(-84, 0)]]) {
      const cells = gridCells(pair, 0);
      expect(cells).toHaveLength(2);
      expect(cells.map((c) => c.lat).sort((a, b) => a - b)).toEqual(pair.map((p) => p.lat).sort((a, b) => a - b));
    }
  });

  it("never makes more cells than an answer may hold, however far in the view says it is zoomed", () => {
    const scattered = Array.from({ length: 5000 }, (_, i) => ({ lat: -60 + (i % 100) * 1.2, lng: -170 + Math.floor(i / 100) * 6.8 })).map((p) => {
      const [x, y] = mercator(p.lat, p.lng);
      return { ...p, x, y };
    });
    const cells = gridCells(scattered, 24);
    expect(cells.length).toBeLessThanOrEqual(MAX_CELLS);
    expect(cells.reduce((n, c) => n + c.n, 0)).toBe(5000);
  });
});
