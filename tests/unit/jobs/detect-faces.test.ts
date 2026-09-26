import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { normalise } from "@/lib/people/cluster";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "faces-photos-"));
vi.hoisted(() => {
  process.env.ML_URL = "http://ml.test";
  process.env.ML_TOKEN = "t";
  process.env.FACE_INDEXING_ENABLED = "true";
});
process.env.PHOTO_STORAGE_ROOT = photoRoot;
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
const ml = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("@/lib/ml/client", async (orig) => ({ ...(await orig()) as object, detectFaces: ml.detect }));

import { detectFacesJob } from "@/lib/jobs/handlers/detect-faces";

/** Two nearby unit vectors, so both land in one unnamed cluster. */
const near = (tilt: number) => normalise(Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : i === 1 ? tilt : 0)));
const BOX: [number, number, number, number] = [0.3, 0.3, 0.2, 0.2];

describe("re-scanning a photo for faces", () => {
  let userId: string;
  const photo = async (key: string) => {
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    writeFileSync(path.join(photoRoot, key, "medium.webp"), "x");
    return (await db.photo.create({ data: { uploaderId: userId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: key, originalPath: `${key}/original.jpg`, sizeBytes: 1, status: "READY", renditions: { medium: { key: `${key}/medium.webp`, w: 10, h: 10 } } } })).id;
  };
  beforeEach(async () => {
    await resetTestDb();
    ml.detect.mockReset();
    userId = (await db.user.create({ data: { email: "fc@example.com", role: "ADMIN" } })).id;
    await db.appSetting.create({ data: { id: "app", faceDetectionOptInAt: new Date(), faceDetectionOptInById: userId } });
  });
  const cluster = async () => (await db.$queryRaw<{ c: string; n: number }[]>`SELECT centroid::text AS c, "faceCount" AS n FROM "FaceCluster"`).map((r) => ({ centroid: JSON.parse(r.c) as number[], faceCount: r.n }));

  it("does not count the same faces into an unnamed cluster's centroid again", async () => {
    const a = await photo("photos/fa");
    const b = await photo("photos/fb");
    ml.detect.mockResolvedValueOnce([{ box: BOX, confidence: 0.9, embedding: near(0), age: 30 }]);
    await detectFacesJob({ photoId: a });
    ml.detect.mockResolvedValue([{ box: BOX, confidence: 0.9, embedding: near(0.5), age: 30 }]);
    await detectFacesJob({ photoId: b });
    const once = await cluster();
    // Edited three more times: each re-scan must leave the cluster exactly as one scan did.
    for (let i = 0; i < 3; i++) await detectFacesJob({ photoId: b });
    const after = await cluster();
    expect(after).toHaveLength(1);
    expect(after[0].faceCount).toBe(2);
    const expected = normalise(near(0).map((x, i) => x + near(0.5)[i]));
    after[0].centroid.slice(0, 2).forEach((x, i) => expect(x).toBeCloseTo(expected[i], 5));
    once[0].centroid.slice(0, 2).forEach((x, i) => expect(after[0].centroid[i]).toBeCloseTo(x, 5));
    expect(await db.face.count()).toBe(2);
  });

  it("leaves a cluster alone when the re-scanned photo had no face in it", async () => {
    const a = await photo("photos/fa");
    const b = await photo("photos/fb");
    ml.detect.mockResolvedValueOnce([{ box: BOX, confidence: 0.9, embedding: near(0), age: 30 }]);
    await detectFacesJob({ photoId: a });
    const before = await cluster();
    ml.detect.mockResolvedValue([]);
    await detectFacesJob({ photoId: b });
    expect(await cluster()).toEqual(before);
  });
});
