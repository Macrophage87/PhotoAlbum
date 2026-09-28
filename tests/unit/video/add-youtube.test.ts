import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const root = mkdtempSync(path.join(tmpdir(), "youtube-add-"));
process.env.PHOTO_STORAGE_ROOT = root;
const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "y@example.com", name: null, role: "MEMBER" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const queue = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => { if (queue.fail) throw new Error("queue unavailable"); return "job"; } }));
const yt = vi.hoisted(() => ({ durationFails: false }));
vi.mock("@/lib/video/youtube", async (orig) => ({
  ...((await orig()) as object),
  oembed: async () => ({ title: "Falls", authorName: "Nana" }),
  fetchThumbnail: async () => Buffer.from("poster"),
  fetchDuration: async () => { if (yt.durationFails) throw new Error("youtube went away"); return 42; },
}));

import { addYouTubeVideo } from "@/app/videos/actions";

const form = () => { const fd = new FormData(); fd.set("url", "https://youtu.be/dQw4w9WgXcQ"); fd.set("date", "2025-08-12"); return fd; };

describe("adding a YouTube video", () => {
  beforeEach(async () => {
    await resetTestDb();
    queue.fail = false; yt.durationFails = false;
    who.id = (await db.user.create({ data: { email: "y@example.com", role: "MEMBER" } })).id;
  });
  it("leaves no row or poster behind when storing it fails", async () => {
    yt.durationFails = true;
    expect((await addYouTubeVideo({ status: "idle" }, form())).status).toBe("error");
    expect(await db.photo.count()).toBe(0);
    expect(existsSync(path.join(root, "photos")) ? readdirSync(path.join(root, "photos")) : []).toEqual([]);
  });
  it("keeps it, marked for Re-process, when its processing cannot be queued", async () => {
    queue.fail = true;
    const r = await addYouTubeVideo({ status: "idle" }, form());
    expect(r.status).toBe("done");
    expect(await db.photo.findFirstOrThrow()).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Re-process/) });
  });
});
