import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "clip-limit-"));
process.env.PHOTO_STORAGE_ROOT = photoRoot;
process.env.MAX_CLIP_SECONDS = "2";
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { CANNOT_CONVERT, transcodeVideo } from "@/lib/jobs/handlers/transcode-video";
import { probe, transcodeArgs } from "@/lib/video/ffmpeg";

/**
 * A WebM written the way a browser's MediaRecorder writes one: as a stream, with nowhere to go back and put the
 * duration, so the container never says how long it is.
 */
function recordedWebm(file: string, seconds: number) {
  const webm = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10", "-t", String(seconds), "-c:v", "libvpx", "-b:v", "50k", "-live", "1", "-f", "webm", "-"]);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, webm);
}

describe("the clip length limit", () => {
  let uploaderId: string;
  beforeEach(async () => {
    await resetTestDb();
    uploaderId = (await db.user.create({ data: { email: "c@example.com" } })).id;
  });
  async function stage(seconds: number) {
    const photo = await db.photo.create({ data: { uploaderId, originalName: "recorded.webm", mimeType: "video/webm", kind: "VIDEO", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING" } });
    const key = `photos/${photo.id}`;
    recordedWebm(path.join(photoRoot, key, "original.webm"), seconds);
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/original.webm` } });
    return photo.id;
  }

  it("is held to a clip whose container does not say how long it is", async () => {
    const id = await stage(6);
    expect((await probe(path.join(photoRoot, `photos/${id}/original.webm`))).durationS).toBeNull();
    await expect(transcodeVideo({ photoId: id })).rejects.toThrow(/more than 2 seconds long/);
    expect(await db.photo.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", error: expect.stringMatching(/^This video is more than 2 seconds long; clips uploaded here are limited to 2 seconds/) });
  }, 60_000);

  it("still takes a short one whose length the container does not give", async () => {
    const id = await stage(1);
    await transcodeVideo({ photoId: id });
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    expect(p.status).toBe("READY");
    expect(p.durationS).toBeGreaterThan(0.5);
  }, 60_000);

  it("stops the transcode just past the limit rather than decoding the whole clip", () => {
    const args = transcodeArgs("in.webm", "out.mp4", { hdr: false }, 91);
    expect(args.slice(-3)).toEqual(["-t", "91", "out.mp4"]);
    expect(transcodeArgs("in.webm", "out.mp4", { hdr: false })).not.toContain("-t");
  });
});

describe("a clip the album cannot convert", () => {
  it("tells the member so in plain words, never with ffmpeg's output or where the file is kept", async () => {
    await resetTestDb();
    const uploaderId = (await db.user.create({ data: { email: "c@example.com" } })).id;
    const photo = await db.photo.create({ data: { uploaderId, originalName: "broken.mp4", mimeType: "video/mp4", kind: "VIDEO", storageKey: "pending", originalPath: "pending", sizeBytes: 1, status: "PENDING" } });
    const key = `photos/${photo.id}`;
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    writeFileSync(path.join(photoRoot, key, "original.mp4"), Buffer.from("not a video at all"));
    await db.photo.update({ where: { id: photo.id }, data: { storageKey: key, originalPath: `${key}/original.mp4` } });
    await expect(transcodeVideo({ photoId: photo.id })).rejects.toThrow();
    const row = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect(row).toMatchObject({ status: "FAILED", error: CANNOT_CONVERT });
  }, 60_000);
});
