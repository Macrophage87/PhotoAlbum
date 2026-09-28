import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { readdir } from "node:fs/promises";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", role: "MEMBER" as "MEMBER" | "ADMIN" }));
const boss = vi.hoisted(() => ({ sent: [] as unknown[], jobs: new Map<string, { state: string; data: unknown; output: unknown }>(), fail: false }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => ({ kind: "user", user: { id: who.id, email: "x@example.com", name: null, role: who.role }, shareTokens: new Map() }) }));
vi.mock("@/lib/jobs/boss", () => ({
  enqueue: async (_q: string, data: unknown) => {
    if (boss.fail) throw new Error("queue unavailable");
    boss.sent.push(data);
    const id = `00000000-0000-4000-8000-${String(boss.sent.length).padStart(12, "0")}`;
    boss.jobs.set(id, { state: "created", data, output: null });
    return id;
  },
  getBoss: async () => ({
    getJobById: async (_q: string, id: string) => {
      // The real pg-boss throws on anything that is not a UUID, which is what the route must not let through.
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid input syntax for type uuid");
      return boss.jobs.get(id) ?? null;
    },
  }),
}));

import { POST } from "@/app/api/tracks/import/route";
import { GET } from "@/app/api/tracks/import/[jobId]/route";
import { importTrackFile } from "@/lib/tracks/import";

const GPX = `<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Walk</name><trkseg><trkpt lat="44.3" lon="-68.2"><time>2025-08-11T10:00:00Z</time></trkpt><trkpt lat="44.31" lon="-68.21"><time>2025-08-11T10:30:00Z</time></trkpt></trkseg></trk></gpx>`;
const post = (tripId: string, name = "walk.gpx") =>
  POST(new Request("https://album.example/api/tracks/import", { method: "POST", body: GPX, headers: { "x-file-name": name, "x-trip-id": tripId, "x-source-hint": "auto" } }));
/** What is in the import inbox on disk. */
const stored = async () => (await readdir(storage().localPath!("imports")).catch(() => [] as string[])).length;
const poll = (jobId: string) => GET(new Request(`https://album.example/api/tracks/import/${jobId}`), { params: Promise.resolve({ jobId }) });

describe("importing tracks is arranging the trip", () => {
  let maker: string, other: string, tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    boss.sent = [];
    boss.jobs.clear();
    maker = (await db.user.create({ data: { email: "maker@example.com" } })).id;
    other = (await db.user.create({ data: { email: "other@example.com" } })).id;
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: maker } })).id;
    who.role = "MEMBER";
    boss.fail = false;
  });

  it("refuses a member who did not make the trip, before anything is stored or queued", async () => {
    who.id = other;
    const before = await stored();
    const res = await post(tripId);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/import tracks/);
    expect(boss.sent).toEqual([]);
    expect(await stored()).toBe(before);
  });

  it("lets the trip's maker, and an admin, import", async () => {
    who.id = maker;
    expect((await post(tripId)).status).toBe(200);
    who.id = other;
    who.role = "ADMIN";
    expect((await post(tripId)).status).toBe(200);
    expect(boss.sent).toHaveLength(2);
  });

  it("refuses an empty file with a reason, keeping and queuing nothing", async () => {
    who.id = maker;
    const before = await stored();
    const res = await POST(new Request("https://album.example/api/tracks/import", { method: "POST", body: new Uint8Array(0), headers: { "x-file-name": "walk.gpx", "x-trip-id": tripId } }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/empty \(0 bytes\)/);
    expect(boss.sent).toEqual([]);
    expect(await stored()).toBe(before);
  });

  it("answers a malformed file name with 400, not a crash", async () => {
    who.id = maker;
    expect((await post(tripId, "%E0.gpx")).status).toBe(400);
  });

  it("keeps no file when the import cannot be queued, since nothing would ever read or delete it", async () => {
    who.id = maker;
    boss.fail = true;
    const before = await stored();
    const res = await post(tripId);
    expect(res.status).toBe(500);
    expect(await stored()).toBe(before);
  });

  it("the job asks again, so a queued import from somebody who may not arrange the trip does nothing", async () => {
    const importKey = "imports/test-walk.gpx";
    await storage().putBuffer(importKey, Buffer.from(GPX));
    await expect(importTrackFile({ importKey, tripId, userId: other, sourceHint: "auto", originalName: "walk.gpx" })).rejects.toThrow(/made this/);
    expect(await db.track.count()).toBe(0);
    expect(await db.activity.count()).toBe(0);
    // And the file it was sent with is not kept.
    expect(await storage().exists(importKey)).toBe(false);
  });

  it("the job refuses the trip's own maker, even an admin, once their removal has begun", async () => {
    await db.user.update({ where: { id: maker }, data: { role: "ADMIN", removingAt: new Date() } });
    const importKey = "imports/test-walk.gpx";
    await storage().putBuffer(importKey, Buffer.from(GPX));
    await expect(importTrackFile({ importKey, tripId, userId: maker, sourceHint: "auto", originalName: "walk.gpx" })).rejects.toThrow(/made this/);
    expect(await db.track.count()).toBe(0);
  });

  it("the job imports nothing into a trip being deleted", async () => {
    await db.trip.update({ where: { id: tripId }, data: { deletingAt: new Date() } });
    const importKey = "imports/test-walk.gpx";
    await storage().putBuffer(importKey, Buffer.from(GPX));
    await expect(importTrackFile({ importKey, tripId, userId: maker, sourceHint: "auto", originalName: "walk.gpx" })).rejects.toThrow(/Trip not found/);
    expect(await db.track.count()).toBe(0);
  });
});

describe("an import's progress is its importer's", () => {
  it("another member polling a job somebody else just started finds nothing", async () => {
    await resetTestDb();
    boss.sent = [];
    boss.jobs.clear();
    const maker = (await db.user.create({ data: { email: "maker@example.com" } })).id;
    const tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: maker } })).id;
    who.id = maker;
    who.role = "MEMBER";
    const { jobId } = await (await post(tripId)).json();
    expect((await poll(jobId)).status).toBe(200);
    who.id = "someone-else";
    expect((await poll(jobId)).status).toBe(404);
  });

  const mine = "11111111-1111-4111-8111-111111111111";
  beforeEach(() => {
    who.id = "me";
    who.role = "MEMBER";
    boss.jobs.clear();
    boss.jobs.set(mine, { state: "completed", data: { userId: "me" }, output: { tracks: [{ name: "Walk", distanceM: 1000 }] } });
  });

  it("shows the importer their own summary", async () => {
    const res = await poll(mine);
    expect(res.status).toBe(200);
    expect((await res.json()).summary.tracks[0].name).toBe("Walk");
  });

  it("finds nothing for anybody else, but an admin sees it", async () => {
    who.id = "someone-else";
    expect((await poll(mine)).status).toBe(404);
    who.role = "ADMIN";
    expect((await poll(mine)).status).toBe(200);
  });

  it("treats an id that is not a job id as not found, not a crash", async () => {
    expect((await poll("not-a-uuid")).status).toBe(404);
  });

  it("tells the importer why it failed, wherever pg-boss put the reason", async () => {
    const failed = async (output: unknown) => {
      boss.jobs.set(mine, { state: "failed", data: { userId: "me" }, output });
      return (await (await poll(mine)).json()).error;
    };
    // An Error is stored as its own fields; anything else thrown (a bare string) under `value`.
    expect(await failed({ name: "Error", message: "No track points found in this file.", stack: "…" })).toBe("No track points found in this file.");
    expect(await failed({ value: "This FIT file is incomplete or damaged." })).toBe("This FIT file is incomplete or damaged.");
    expect(await failed({ value: { message: "Unreadable export" } })).toBe("Unreadable export");
    // pg-boss's own words for a job it stopped are put in the album's.
    expect(await failed({ name: "Error", message: "handler execution exceeded 3600s" })).toBe("The import took too long and was stopped.");
    // What pg-boss writes when it expires a job whose worker died with it.
    expect(await failed({ value: { message: "job timed out" } })).toBe("The import took too long and was stopped.");
    expect(await failed(null)).toBe("Import failed");
  });
});
