import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const photoRoot = mkdtempSync(path.join(tmpdir(), "animals-photos-"));
vi.hoisted(() => {
  process.env.ML_URL = "http://ml.test";
  process.env.ML_TOKEN = "t";
  process.env.PET_MATCHING_ENABLED = "true";
});
process.env.PHOTO_STORAGE_ROOT = photoRoot;
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
const ml = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock("@/lib/ml/client", async (orig) => ({ ...(await orig()) as object, detectAnimals: ml.detect }));

import { detectAnimalsJob } from "@/lib/jobs/handlers/detect-animals";
import { MlError } from "@/lib/ml/client";

const unit = (seed: number) => {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(seed * 7 + i * 1.3));
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
};
const DOG_BOX: [number, number, number, number] = [0.1, 0.5, 0.4, 0.4];
const CAT_BOX: [number, number, number, number] = [0.6, 0.6, 0.25, 0.3];

describe("the animal detection job", () => {
  let photoId: string, userId: string, petId: string;
  beforeEach(async () => {
    await resetTestDb();
    ml.detect.mockReset();
    userId = (await db.user.create({ data: { email: "an@example.com", role: "ADMIN" } })).id;
    petId = (await db.person.create({ data: { kind: "PET", name: "Biscuit", species: "DOG", createdById: userId } })).id;
    const key = "photos/a1";
    mkdirSync(path.join(photoRoot, key), { recursive: true });
    writeFileSync(path.join(photoRoot, key, "medium.webp"), "x");
    photoId = (await db.photo.create({ data: { uploaderId: userId, originalName: "a.jpg", mimeType: "image/jpeg", storageKey: key, originalPath: `${key}/original.jpg`, sizeBytes: 1, status: "READY", renditions: { medium: { key: `${key}/medium.webp`, w: 10, h: 10 }, thumb: { key: `${key}/thumb.webp`, w: 4, h: 4 } } } })).id;
  });
  const rows = () => db.$queryRaw<{ id: string; species: string; status: string; personId: string | null; proposedPersonId: string | null; hasEmbedding: boolean }[]>`SELECT id, species::text AS species, status::text AS status, "personId", "proposedPersonId", embedding IS NOT NULL AS "hasEmbedding" FROM "AnimalDetection" WHERE "photoId" = ${photoId} ORDER BY species`;

  it("stores each animal with its embedding and marks the photo scanned", async () => {
    ml.detect.mockResolvedValue([{ box: DOG_BOX, species: "DOG", confidence: 0.9, embedding: unit(1) }, { box: CAT_BOX, species: "CAT", confidence: 0.8, embedding: unit(2) }]);
    await detectAnimalsJob({ photoId });
    const r = await rows();
    expect(r.map((x) => [x.species, x.status, x.hasEmbedding])).toEqual([["CAT", "DETECTED", true], ["DOG", "DETECTED", true]]);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).animalsDetectedAt).not.toBeNull();
  });
  it("re-scans without disturbing confirmed and rejected rows, and fills in a confirmed row's missing embedding", async () => {
    // As the seed writes it: a confirmed sighting with no embedding yet, plus a rejection a member made.
    const confirmed = await db.animalDetection.create({ data: { photoId, personId: petId, species: "DOG", box: DOG_BOX, confidence: 0.9, status: "CONFIRMED" }, select: { id: true } });
    const rejected = await db.animalDetection.create({ data: { photoId, proposedPersonId: petId, species: "CAT", box: CAT_BOX, confidence: 0.8, status: "REJECTED" }, select: { id: true } });
    const stale = await db.animalDetection.create({ data: { photoId, species: "HORSE", box: [0.5, 0.1, 0.2, 0.2], confidence: 0.7, status: "DETECTED" }, select: { id: true } });
    ml.detect.mockResolvedValue([{ box: DOG_BOX, species: "DOG", confidence: 0.9, embedding: unit(1) }, { box: CAT_BOX, species: "CAT", confidence: 0.8, embedding: unit(2) }]);
    await detectAnimalsJob({ photoId });
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.id === confirmed.id)).toMatchObject({ status: "CONFIRMED", personId: petId, hasEmbedding: true });
    expect(r.find((x) => x.id === rejected.id)).toMatchObject({ status: "REJECTED", proposedPersonId: petId, hasEmbedding: true });
    expect(r.find((x) => x.id === stale.id)).toBeUndefined();
  });
  it("marks the photo scanned and keeps quiet when the sidecar has no detector weights", async () => {
    ml.detect.mockRejectedValue(new MlError("no detector", 503));
    await expect(detectAnimalsJob({ photoId })).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).animalsDetectedAt).not.toBeNull();
  });
  it("lets other sidecar errors surface so the job retries", async () => {
    ml.detect.mockRejectedValue(new MlError("unreachable"));
    await expect(detectAnimalsJob({ photoId })).rejects.toThrow();
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).animalsDetectedAt).toBeNull();
  });
});
