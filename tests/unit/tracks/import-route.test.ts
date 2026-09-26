import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const root = mkdtempSync(path.join(tmpdir(), "track-route-"));
process.env.PHOTO_STORAGE_ROOT = root;
const viewer = vi.hoisted(() => ({ kind: "user" as const, user: { id: "", email: "t@example.com", name: null, role: "ADMIN" as const } }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => viewer }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => { throw new Error("queue unavailable"); } }));

import { POST } from "@/app/api/tracks/import/route";

describe("the track import route", () => {
  let tripId: string;
  beforeEach(async () => {
    await resetTestDb();
    viewer.user.id = (await db.user.create({ data: { email: "t@example.com", role: "ADMIN" } })).id;
    tripId = (await db.trip.create({ data: { slug: "t", title: "T", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: viewer.user.id } })).id;
  });
  it("keeps no file when the import cannot be queued, since nothing would ever read or delete it", async () => {
    const r = await POST(new Request("http://album.test/api/tracks/import", { method: "POST", body: "<gpx/>", headers: { "x-file-name": "walk.gpx", "x-trip-id": tripId } }));
    expect(r.status).toBe(500);
    const dir = path.join(root, "imports");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});
