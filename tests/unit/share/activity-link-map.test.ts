import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { encodePoints } from "@/lib/tracks/encode";
import { resetTestDb } from "../helpers/reset";

vi.hoisted(() => { process.env.APP_URL = process.env.APP_URL || "https://album.example"; });
// Who is asking: an anonymous visitor holding whatever share cookies the test hands them, or a member.
const who = vi.hoisted(() => ({ member: false, tokens: new Map<string, string>() }));
vi.mock("@/lib/auth/viewer", () => ({
  SHARE_COOKIE_PREFIX: "share_",
  getViewer: async () => (who.member ? { kind: "user", user: { id: "m", email: "m@example.com", name: null, role: "MEMBER" }, shareTokens: who.tokens } : { kind: "anonymous", user: null, shareTokens: who.tokens }),
}));

import { GET as activityGeojson } from "@/app/api/activities/[id]/geojson/route";
import { GET as tripGeojson } from "@/app/api/trips/[slug]/geojson/route";
import { GET as trackPoints } from "@/app/api/tracks/[id]/points/route";
import { generateMetadata } from "@/app/share/a/[token]/page";

const at = (m: number) => new Date(Date.UTC(2025, 7, 11, 10, m));
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const req = (path: string) => new Request(`https://album.example${path}`);

async function track(tripId: string, uploaderId: string, name: string) {
  const { blob, startTime, endTime } = encodePoints([{ t: at(0).getTime(), lat: 44.3, lng: -68.2 }, { t: at(30).getTime(), lat: 44.31, lng: -68.21 }]);
  return db.track.create({
    data: { tripId, uploaderId, source: "GPX", name, startTime, endTime, pointCount: 2, minLat: 44.3, maxLat: 44.31, minLng: -68.21, maxLng: -68.2, simplified: [[44.3, -68.2], [44.31, -68.21]], pointsBlob: new Uint8Array(blob) },
  });
}

describe("a shared activity on a private trip", () => {
  let tripId: string, walkId: string, walkTrack: string, boatTrack: string, boatId: string, onWalk: string;
  beforeEach(async () => {
    await resetTestDb();
    who.member = false;
    who.tokens = new Map();
    const u = await db.user.create({ data: { email: "jo@example.com", name: "Grandma Jo" } });
    const trip = await db.trip.create({ data: { slug: "acadia", title: "Secret Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: u.id, visibility: "PRIVATE" } });
    tripId = trip.id;
    // Named after its file, which names the trip: the link must not pass that on.
    const t1 = await track(trip.id, u.id, "Secret Acadia walk.gpx");
    const t2 = await track(trip.id, u.id, "boat.gpx");
    walkTrack = t1.id;
    boatTrack = t2.id;
    walkId = (await db.activity.create({ data: { tripId: trip.id, title: "Ocean Path", type: "HIKE", startTime: at(0), endTime: at(30), trackId: t1.id, shareToken: "walk-token" } })).id;
    boatId = (await db.activity.create({ data: { tripId: trip.id, title: "Mail boat", type: "OTHER", startTime: at(0), endTime: at(30), trackId: t2.id } })).id;
    const photo = (activityId: string | null, name: string, extra: Record<string, unknown> = {}) =>
      db.photo.create({ data: { uploaderId: u.id, tripId: trip.id, activityId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", lat: 44.3, lng: -68.2, takenAt: at(10), ...extra } });
    onWalk = (await photo(walkId, "walk.jpg")).id;
    await photo(boatId, "boat.jpg");
    await photo(null, "loose.jpg");
    // Filed on the walk but not part of what the link shows: in the trash, still processing, or (stale) off the trip.
    await photo(walkId, "trashed.jpg", { trashedAt: new Date(), trashReason: "ACCIDENT" });
    await photo(walkId, "pending.jpg", { status: "PENDING" });
    await photo(walkId, "offtrip.jpg", { tripId: null });
  });

  it("is refused to a stranger without the link, as the trip is", async () => {
    expect((await activityGeojson(req(`/api/activities/${walkId}/geojson`), ctx({ id: walkId }))).status).toBe(404);
    expect((await trackPoints(req(`/api/tracks/${walkTrack}/points`), ctx({ id: walkTrack }))).status).toBe(404);
  });

  it("opens exactly its own track and photographs to whoever holds the link, and nothing else of the trip", async () => {
    who.tokens.set(`activity_${walkId}`, "walk-token");
    const res = await activityGeojson(req(`/api/activities/${walkId}/geojson`), ctx({ id: walkId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photos.features.map((f: { properties: { id: string } }) => f.properties.id)).toEqual([onWalk]);
    expect(body.tracks.features.map((f: { properties: { trackId: string } }) => f.properties.trackId)).toEqual([walkTrack]);
    expect(body.tracks.features[0].properties.name).toBe("Ocean Path");
    expect(body.trips).toEqual([]);
    expect(body.bounds).not.toBeNull();
    // The trip is private: the link does not name it, nor say who uploaded anything.
    const text = JSON.stringify(body);
    expect(text).not.toContain("Secret Acadia");
    expect(text).not.toContain("acadia");
    expect(text).not.toContain("Grandma Jo");
    expect(text).not.toContain("Mail boat");

    const points = await trackPoints(req(`/api/tracks/${walkTrack}/points`), ctx({ id: walkTrack }));
    expect(points.status).toBe(200);
    expect((await points.json()).points.lat).toHaveLength(2);
    // A link can be withdrawn, so what it opened is not cached.
    expect(points.headers.get("Cache-Control")).toBe("private, no-store");

    // Not the other activity, not its track, not the trip's map.
    expect((await activityGeojson(req(`/api/activities/${boatId}/geojson`), ctx({ id: boatId }))).status).toBe(404);
    expect((await trackPoints(req(`/api/tracks/${boatTrack}/points`), ctx({ id: boatTrack }))).status).toBe(404);
    expect((await tripGeojson(req("/api/trips/acadia/geojson"), ctx({ slug: "acadia" }))).status).toBe(404);
  });

  it("a cookie that no longer matches the activity's link opens nothing", async () => {
    who.tokens.set(`activity_${walkId}`, "old-token");
    expect((await activityGeojson(req(`/api/activities/${walkId}/geojson`), ctx({ id: walkId }))).status).toBe(404);
    expect((await trackPoints(req(`/api/tracks/${walkTrack}/points`), ctx({ id: walkTrack }))).status).toBe(404);
  });

  it("members see the activity on its trip as before, named and with uploaders", async () => {
    who.member = true;
    const body = await (await activityGeojson(req(`/api/activities/${walkId}/geojson`), ctx({ id: walkId }))).json();
    expect(body.tracks.features[0].properties).toMatchObject({ trackId: walkTrack, name: "Secret Acadia walk.gpx", tripSlug: "acadia", tripTitle: "Secret Acadia", uploaderName: "Grandma Jo" });
    expect(body.photos.features.map((f: { properties: { id: string } }) => f.properties.id)).toEqual([onWalk]);
    const points = await trackPoints(req(`/api/tracks/${walkTrack}/points`), ctx({ id: walkTrack }));
    expect(points.headers.get("Cache-Control")).toBe("private, max-age=3600");
  });

  it("a member looking at the link's map sees what the link shows: the private trip is not named", async () => {
    who.member = true;
    const body = await (await activityGeojson(req(`/api/activities/${walkId}/geojson?view=share`), ctx({ id: walkId }))).json();
    expect(body.tracks.features[0].properties).toMatchObject({ trackId: walkTrack, tripSlug: "", tripTitle: "" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("Secret Acadia");
    expect(text).not.toContain("acadia");
    expect(text).not.toContain("Grandma Jo");
    // A public trip is named to anybody, so to the link's map as well.
    await db.trip.update({ where: { id: tripId }, data: { visibility: "PUBLIC" } });
    const open = await (await activityGeojson(req(`/api/activities/${walkId}/geojson?view=share`), ctx({ id: walkId }))).json();
    expect(open.tracks.features[0].properties).toMatchObject({ tripSlug: "acadia", tripTitle: "Secret Acadia" });
  });

  it("the link's preview names the trip only when the trip is public", async () => {
    const meta = async () => generateMetadata({ params: Promise.resolve({ token: "walk-token" }) } as never);
    const hidden = await meta();
    expect(hidden.title).toBe("Ocean Path");
    expect(JSON.stringify(hidden)).not.toContain("Secret Acadia");
    expect(String(hidden.openGraph?.description)).toMatch(/2025/);
    await db.trip.update({ where: { id: tripId }, data: { visibility: "PUBLIC" } });
    expect(String((await meta()).openGraph?.description)).toContain("Secret Acadia");
  });
});
