import { readFile } from "node:fs/promises";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import { detectFaces, vectorLiteral } from "@/lib/ml/client";
import { faceGates } from "@/lib/people/gates";
import { nearestCluster, updatedCentroid } from "@/lib/people/cluster";
import { withHeavyLock } from "../heavy-lock";
import { enqueue } from "../boss";
import { QUEUES, type DetectFacesJob } from "../queues";

/**
 * Detect faces on the medium rendition, store templates, and place each face in the nearest unnamed cluster
 * (or a new one). Matching against named people is a later phase. Under the heavy lock, one photo at a time.
 */
export async function detectFacesJob(job: DetectFacesJob): Promise<void> {
  const gates = await faceGates();
  if (!gates.active) return;
  const photo = await db.photo.findUnique({ where: { id: job.photoId }, select: { id: true, status: true, renditions: true, facesDetectedAt: true } });
  if (!photo || photo.status !== "READY") return;
  const medium = (photo.renditions as Renditions | null)?.medium;
  const local = medium ? storage().localPath?.(medium.key) : undefined;
  if (!local) return;
  await withHeavyLock(async () => {
    const found = await detectFaces(await readFile(local));
    await db.face.deleteMany({ where: { photoId: photo.id, status: "DETECTED" } });
    // Unnamed clusters only: named ones are the matcher's business.
    const clusters = (await db.$queryRaw<{ id: string; centroid: string; faceCount: number }[]>`SELECT id, centroid::text AS centroid, "faceCount" FROM "FaceCluster" WHERE "personId" IS NULL AND centroid IS NOT NULL`).map((c) => ({ id: c.id, centroid: JSON.parse(c.centroid) as number[], faceCount: c.faceCount }));
    for (const f of found) {
      const hit = nearestCluster(f.embedding, clusters);
      let clusterId: string;
      if (hit) {
        clusterId = hit.cluster.id;
        const next = updatedCentroid(hit.cluster.centroid, hit.cluster.faceCount, f.embedding);
        hit.cluster.centroid = next;
        hit.cluster.faceCount += 1;
        await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(next)}::vector, "faceCount" = "faceCount" + 1, "updatedAt" = now() WHERE id = ${clusterId}`;
      } else {
        const created = await db.faceCluster.create({ data: { faceCount: 1 }, select: { id: true } });
        clusterId = created.id;
        await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(f.embedding)}::vector WHERE id = ${clusterId}`;
        clusters.push({ id: clusterId, centroid: f.embedding, faceCount: 1 });
      }
      const face = await db.face.create({ data: { photoId: photo.id, clusterId, box: f.box, confidence: f.confidence, ageAtCaptureYears: f.age, status: "DETECTED" }, select: { id: true } });
      await db.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(f.embedding)}::vector WHERE id = ${face.id}`;
    }
    await db.photo.update({ where: { id: photo.id }, data: { facesDetectedAt: new Date() } });
  });
}

export async function enqueueFaceDetection(photoId: string): Promise<void> {
  const gates = await faceGates();
  if (!gates.active) return;
  await enqueue(QUEUES.detectFaces, { photoId }, { singletonKey: `faces:${photoId}`, singletonSeconds: 60 });
}

/** Catch-up: ready photos not yet scanned (photos and posters; clips use their poster). */
export async function faceSweep(): Promise<number> {
  const gates = await faceGates();
  if (!gates.active) return 0;
  const rows = await db.photo.findMany({ where: { status: "READY", facesDetectedAt: null, renditions: { not: Prisma.DbNull } }, select: { id: true }, orderBy: { createdAt: "desc" }, take: 100 });
  for (const r of rows) await enqueue(QUEUES.detectFaces, { photoId: r.id }, { singletonKey: `faces:${r.id}`, singletonSeconds: 60 });
  return rows.length;
}

/** Faces nobody named (guests, bystanders) are not kept forever: purge them, and empty clusters, after the retention window. */
export async function purgeUnnamedFaces(): Promise<number> {
  const gates = await faceGates();
  const cutoff = new Date(Date.now() - gates.retentionDays * 86_400_000);
  const res = await db.face.deleteMany({ where: { personId: null, proposedPersonId: null, createdAt: { lt: cutoff }, cluster: { OR: [{ personId: null }, { person: { pendingDecision: false, faceIndexing: false } }] } } });
  await db.faceCluster.deleteMany({ where: { personId: null, faces: { none: {} } } });
  return res.count;
}
