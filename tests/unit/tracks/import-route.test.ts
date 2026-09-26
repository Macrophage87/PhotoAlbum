import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", role: "MEMBER" as "MEMBER" | "ADMIN" }));
const boss = vi.hoisted(() => ({ sent: [] as unknown[], jobs: new Map<string, { state: string; data: unknown; output: unknown }>() }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => ({ kind: "user", user: { id: who.id, email: "x@example.com", name: null, role: who.role }, shareTokens: new Map() }) }));
vi.mock("@/lib/jobs/boss", () => ({
  enqueue: async (_q: string, data: unknown) => { boss.sent.push(data); return "00000000-0000-4000-8000-000000000001"; },
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
  });

  it("refuses a member who did not make the trip, before anything is stored or queued", async () => {
    who.id = other;
    const res = await post(tripId);
    expect(res.status).toBe(403);
    expect(boss.sent).toEqual([]);
  });

  it("lets the trip's maker, and an admin, import", async () => {
    who.id = maker;
    expect((await post(tripId)).status).toBe(200);
    who.id = other;
    who.role = "ADMIN";
    expect((await post(tripId)).status).toBe(200);
    expect(boss.sent).toHaveLength(2);
  });

  it("answers a malformed file name with 400, not a crash", async () => {
    who.id = maker;
    expect((await post(tripId, "%E0.gpx")).status).toBe(400);
  });

  it("the job asks again, so a queued import from somebody who may not arrange the trip does nothing", async () => {
    const importKey = "imports/test-walk.gpx";
    await storage().putBuffer(importKey, Buffer.from(GPX));
    await expect(importTrackFile({ importKey, tripId, userId: other, sourceHint: "auto", originalName: "walk.gpx" })).rejects.toThrow(/made this/);
    expect(await db.track.count()).toBe(0);
    expect(await db.activity.count()).toBe(0);
  });
});

describe("an import's progress is its importer's", () => {
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
});
