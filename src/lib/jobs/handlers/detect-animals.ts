import { readFile } from "node:fs/promises";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import { detectAnimals, MlError } from "@/lib/ml/client";
import { boxIou } from "@/lib/people/match";
import { petGates } from "@/lib/pets/gates";
import { proposeAnimalsForPhoto, setAnimalEmbedding } from "@/lib/pets/proposals";
import { withHeavyLock } from "../heavy-lock";
import { enqueue } from "../boss";
import { QUEUES, type DetectAnimalsJob } from "../queues";

/**
 * Find animals on the medium rendition and keep each with its species and crop embedding, then propose pets.
 * Confirmed and rejected rows survive a re-scan (a confirmed row without an embedding, as the seed writes, gets one
 * back from the matching detection). Under the heavy lock, one photo at a time.
 */
export async function detectAnimalsJob(job: DetectAnimalsJob): Promise<void> {
  if (!petGates().active) return;
  const photo = await db.photo.findUnique({ where: { id: job.photoId }, select: { id: true, status: true, renditions: true } });
  if (!photo || photo.status !== "READY") return;
  const medium = (photo.renditions as Renditions | null)?.medium;
  const local = medium ? storage().localPath?.(medium.key) : undefined;
  if (!local) return;
  await withHeavyLock(async () => {
    let detected;
    try {
      detected = await detectAnimals(await readFile(local));
    } catch (err) {
      if (err instanceof MlError && err.status === 503) {
        // No detector weights on the sidecar: note it once per photo rather than retrying forever.
        console.warn("[animals] sidecar has no animal detector weights; run ml-init again");
        await db.photo.update({ where: { id: photo.id }, data: { animalsDetectedAt: new Date() } });
        return;
      }
      throw err;
    }
    await db.animalDetection.deleteMany({ where: { photoId: photo.id, status: { in: ["DETECTED", "PROPOSED"] } } });
    const kept = await db.$queryRaw<{ id: string; box: number[]; hasEmbedding: boolean }[]>`SELECT id, box, embedding IS NOT NULL AS "hasEmbedding" FROM "AnimalDetection" WHERE "photoId" = ${photo.id}`;
    for (const a of detected) {
      const same = kept.find((k) => boxIou(k.box as [number, number, number, number], a.box) > 0.5 || (k.box as number[])[2] === 1);
      if (same) {
        if (!same.hasEmbedding) await setAnimalEmbedding(same.id, a.embedding);
        continue;
      }
      const row = await db.animalDetection.create({ data: { photoId: photo.id, species: a.species, box: a.box, confidence: a.confidence, status: "DETECTED" }, select: { id: true } });
      await setAnimalEmbedding(row.id, a.embedding);
    }
    await db.photo.update({ where: { id: photo.id }, data: { animalsDetectedAt: new Date() } });
  });
  await proposeAnimalsForPhoto(photo.id);
}

export async function enqueueAnimalDetection(...photoIds: string[]): Promise<void> {
  if (!petGates().active) return;
  for (const photoId of photoIds) await enqueue(QUEUES.detectAnimals, { photoId }, { singletonKey: `animals:${photoId}`, singletonSeconds: 60 });
}

/** Catch-up: ready items not yet scanned for animals. */
export async function animalSweep(): Promise<number> {
  if (!petGates().active) return 0;
  const rows = await db.photo.findMany({ where: { status: "READY", animalsDetectedAt: null, renditions: { not: Prisma.DbNull } }, select: { id: true }, orderBy: { createdAt: "desc" }, take: 100 });
  for (const r of rows) await enqueue(QUEUES.detectAnimals, { photoId: r.id }, { singletonKey: `animals:${r.id}`, singletonSeconds: 60 });
  return rows.length;
}

/** Every photo with an open detection: run after a pet gains its first confirmed crop. */
export async function enqueueAnimalMatchAllOpen(): Promise<number> {
  const rows = await db.animalDetection.findMany({ where: { status: "DETECTED" }, select: { photoId: true }, distinct: ["photoId"] });
  for (const r of rows) await enqueue(QUEUES.matchAnimals, { photoId: r.photoId }, { singletonKey: `match-animals:${r.photoId}`, singletonSeconds: 30 });
  return rows.length;
}
