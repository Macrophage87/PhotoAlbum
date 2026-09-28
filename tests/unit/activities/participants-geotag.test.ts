import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const root = mkdtempSync(path.join(tmpdir(), "participants-geotag-"));
process.env.PHOTO_STORAGE_ROOT = root;
const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "dad@example.com", name: null, role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => "job" }));

import { importTrack } from "@/lib/jobs/handlers/import-track";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";
import { updateActivity } from "@/app/trips/[slug]/activities/actions";

afterAll(() => rmSync(root, { recursive: true, force: true }));

const M = 60_000;
const START = Date.parse("2025-08-13T03:00:00Z"); // 23:00 in New York, a ride past midnight

/** A ride north, one point a minute for two hours, as a GPX file where the import route would have put it. */
function gpx(): string {
  const pts = Array.from({ length: 121 }, (_, i) => `<trkpt lat="${(44 + i * 0.001).toFixed(3)}" lon="-68"><time>${new Date(START + i * M).toISOString()}</time></trkpt>`).join("");
  mkdirSync(path.join(root, "imports"), { recursive: true });
  writeFileSync(path.join(root, "imports/ride.gpx"), `<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Night ride</name><trkseg>${pts}</trkseg></trk></gpx>`);
  return "imports/ride.gpx";
}

/** Naming who was on a ride after it was imported takes back the places its track gave everybody else's photos. */
describe("naming who was on an imported ride", () => {
  let dad: string, mom: string, tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    dad = who.id = (await db.user.create({ data: { email: "dad@example.com" } })).id;
    mom = (await db.user.create({ data: { email: "mom@example.com" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), timezone: "America/New_York", createdById: dad } })).id;
  });
  const photo = (uploaderId: string, extra: Record<string, unknown> = {}) =>
    db.photo.create({ data: { tripId, uploaderId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date(START + 90 * M), takenAtSource: "EXIF_OFFSET", ...extra } });
  const row = (id: string) => db.photo.findUniqueOrThrow({ where: { id } });
  const edit = (activityId: string, participants: string[]) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ title: "Night ride", type: "BIKE", start: "2025-08-12T23:00", end: "2025-08-13T01:00", participantsPresent: "1" })) fd.append(k, v);
    for (const p of participants) fd.append("participants", p);
    return expect(updateActivity("acadia", activityId, { status: "idle" }, fd)).rejects.toThrow(/REDIRECT/);
  };

  it("clears her photo off his route, asks again about a place it replaced, and places it again once un-named", async () => {
    const hers = await photo(mom);
    const guessed = await photo(mom, { lat: 41, lng: -70, gpsSource: "ESTIMATE", placeEstimateName: "Home", placeEstimatedAt: new Date() });
    const his = await photo(dad);
    const pinned = await photo(mom, { lat: 1, lng: 2, gpsSource: "EXIF" });

    // The import makes the activity (nobody named) and places everybody's photos from its track, as the job does.
    const summary = (await importTrack({ importKey: gpx(), tripId, userId: dad, sourceHint: "auto", originalName: "ride.gpx" })) as { tracks: { trackId: string; activityId: string }[] };
    await geotagPhotos({ tripId, trackIds: summary.tracks.map((t) => t.trackId) });
    const [{ activityId }] = summary.tracks;
    for (const p of [hers, guessed, his]) expect(await row(p.id)).toMatchObject({ gpsSource: "TRACK", activityId });

    // Only he was on it: her photos come off the ride and off his route; his stay, and so does her camera's own GPS.
    await edit(activityId, [dad]);
    expect(await row(hers.id)).toMatchObject({ activityId: null, lat: null, lng: null, gpsSource: null });
    expect(await row(guessed.id)).toMatchObject({ lat: null, gpsSource: null, placeEstimatedAt: null });
    expect(await row(his.id)).toMatchObject({ gpsSource: "TRACK", activityId });
    expect(await row(pinned.id)).toMatchObject({ lat: 1, lng: 2, gpsSource: "EXIF" });
    // A later run leaves it so.
    await geotagPhotos({ tripId });
    expect(await row(hers.id)).toMatchObject({ lat: null, gpsSource: null });

    // Nobody named again: the track is everybody's once more.
    await edit(activityId, []);
    expect(await row(hers.id)).toMatchObject({ gpsSource: "TRACK" });
  });

  it("leaves a place a member pinned by hand alone", async () => {
    const summary = (await importTrack({ importKey: gpx(), tripId, userId: dad, sourceHint: "auto", originalName: "ride.gpx" })) as { tracks: { activityId: string }[] };
    const hers = await photo(mom, { lat: 44.05, lng: -68, gpsSource: "TRACK", placeSetById: mom });
    await edit(summary.tracks[0].activityId, [dad]);
    expect(await row(hers.id)).toMatchObject({ lat: 44.05, gpsSource: "TRACK" });
  });
});
