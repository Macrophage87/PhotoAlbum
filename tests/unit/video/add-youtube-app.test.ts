import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

process.env.PHOTO_STORAGE_ROOT = mkdtempSync(path.join(tmpdir(), "youtube-app-"));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => "job" }));
vi.mock("@/lib/video/youtube", async (orig) => ({
  ...((await orig()) as object),
  oembed: async () => ({ title: "Falls", authorName: "Nana" }),
  fetchThumbnail: async () => Buffer.from("poster"),
  fetchDuration: async () => 42,
}));

import { createDeviceToken } from "@/lib/auth/device-token";
import { POST } from "@/app/api/v1/videos/route";

describe("adding a YouTube link from the app", () => {
  let userId: string;
  let token: string;
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "pat@example.com" } })).id;
    token = (await createDeviceToken(db, userId)).token;
  });
  const post = (body: unknown, auth = true) =>
    POST(new Request("http://localhost/api/v1/videos", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));

  it("needs a signed-in phone", async () => {
    expect((await post({ url: "https://youtu.be/dQw4w9WgXcQ", date: "2025-08-12" }, false)).status).toBe(401);
    expect(await db.photo.count()).toBe(0);
  });
  it("adds the video as the member's, on the trip they chose and the day they gave", async () => {
    const trip = await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), timezone: "America/New_York", createdById: userId } });
    const res = await post({ url: "https://youtu.be/dQw4w9WgXcQ", date: "2025-08-12", tripId: trip.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Falls");
    expect(await db.photo.findUniqueOrThrow({ where: { id: body.photoId } })).toMatchObject({ uploaderId: userId, tripId: trip.id, kind: "EXTERNAL_VIDEO", externalId: "dQw4w9WgXcQ", takenAt: new Date("2025-08-12T16:00:00Z") });
  });
  it("says why in words when it cannot", async () => {
    const notYouTube = await post({ url: "https://example.com/video", date: "2025-08-12" });
    expect(notYouTube.status).toBe(422);
    expect((await notYouTube.json()).error).toMatch(/YouTube link/);
    const noTrip = await post({ url: "https://youtu.be/dQw4w9WgXcQ", date: "2025-08-12", tripId: "gone" });
    expect(noTrip.status).toBe(422);
    expect((await post({ url: "https://youtu.be/dQw4w9WgXcQ" })).status).toBe(400);
    expect((await post("nonsense")).status).toBe(400);
    expect(await db.photo.count()).toBe(0);
  });
});
