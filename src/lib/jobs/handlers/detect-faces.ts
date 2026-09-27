import { readFile } from "node:fs/promises";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import { detectFaces, vectorLiteral } from "@/lib/ml/client";
import { faceGates } from "@/lib/people/gates";
import { nearestCluster, updatedCentroid } from "@/lib/people/cluster";
import { boxIou } from "@/lib/people/match";
import { joinEraCluster, proposeForPhoto } from "@/lib/people/matching";
import { ageAtCapture } from "@/lib/people/match";
import { normalise } from "@/lib/people/cluster";
import { withHeavyLock } from "../heavy-lock";
import { enqueue } from "../boss";
import { QUEUES, type DetectFacesJob } from "../queues";
import { NOT_TRASHED } from "@/lib/photos/trash";

/**
 * Detect faces on the medium rendition, store templates, and place each face in the nearest unnamed cluster
 * (or a new one). Matching against named people is a later phase. Under the heavy lock, one photo at a time.
 */
export async function detectFacesJob(job: DetectFacesJob, signal?: AbortSignal): Promise<void> {
  const gates = await faceGates();
  if (!gates.active) return;
  const photo = await db.photo.findUnique({ where: { id: job.photoId }, select: { id: true, status: true, renditions: true, facesDetectedAt: true, takenAt: true, takenAtSource: true, estimatedDate: true } });
  if (!photo || photo.status !== "READY") return;
  const medium = (photo.renditions as Renditions | null)?.medium;
  const local = medium ? storage().localPath?.(medium.key) : undefined;
  if (!local) return;
  await withHeavyLock(async () => {
    const detected = await detectFaces(await readFile(local), undefined, signal);
    // Timed out while the sidecar answered: the retry owns this photo now.
    signal?.throwIfAborted();
    // A re-scan keeps what people decided (confirmed and rejected faces) and only re-finds the rest.
    // The groups come from the delete itself, so a face moved between a read and the delete is still counted.
    const lightened = [
      ...new Set(
        // The rows locked in id order first, as naming locks faces, so the two wait for each other rather than deadlock.
        (await db.$queryRaw<{ clusterId: string | null }[]>`DELETE FROM "Face" WHERE id IN (SELECT id FROM "Face" WHERE "photoId" = ${photo.id} AND status IN ('DETECTED', 'PROPOSED') ORDER BY id FOR UPDATE) AND status IN ('DETECTED', 'PROPOSED') RETURNING "clusterId"`)
          .map((r) => r.clusterId)
          .filter((c): c is string => c !== null),
      ),
    ];
    const kept = await db.face.findMany({ where: { photoId: photo.id }, select: { id: true, box: true, personId: true, confidence: true, clusterId: true, ageAtCaptureYears: true } });
    const found = detected.filter((f) => !kept.some((k) => k.confidence > 0 && boxIou(k.box as [number, number, number, number], f.box) > 0.5));
    // Kept faces of consented people get their template back (it was nulled while recognition was off), and their
    // person's era centroids are rebuilt from the faces that now carry templates.
    const restoredFor = new Set<string>();
    for (const k of kept) {
      const again = detected.find((f) => k.confidence > 0 && boxIou(k.box as [number, number, number, number], f.box) > 0.5);
      if (!again || !k.personId) continue;
      const personId = k.personId;
      // Their recognition read under a lock until the template is back (person, then face, then era group): switched
      // off meanwhile, the switch either comes first and is seen here, or waits and nulls what this restores.
      await db.$transaction(async (tx) => {
        const [person] = await tx.$queryRaw<{ faceIndexing: boolean; birthday: Date | null }[]>`SELECT "faceIndexing", birthday FROM "Person" WHERE id = ${personId} FOR SHARE`;
        if (!person?.faceIndexing) return;
        const n = await tx.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(again.embedding)}::vector WHERE id = ${k.id} AND embedding IS NULL`;
        if (n > 0) restoredFor.add(personId);
        // A face named while recognition was off has no era cluster yet; give it one now so the matcher can find this person.
        if (!k.clusterId) {
          restoredFor.add(personId);
          const realDate = photo.takenAt && photo.takenAtSource !== "FILE_MTIME" && photo.takenAtSource !== "UPLOAD_TIME" ? photo.takenAt : null;
          await joinEraCluster(k.id, personId, again.embedding, ageAtCapture(person.birthday, realDate, photo.estimatedDate, k.ageAtCaptureYears), tx);
        }
      });
    }
    for (const personId of restoredFor) await rebuildCentroids(personId);
    // Deleted faces leave their unnamed clusters lighter: their counts, and running means that still carry the faces
    // about to be added again, are made again from what they hold now — only those clusters, and under their locks,
    // so a group being named or carved at the same moment is neither counted from a stale read nor overwritten.
    if (lightened.length) {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "FaceCluster" WHERE id = ANY(${lightened}) ORDER BY id FOR UPDATE`;
        await rebuildUnnamedCentroids(lightened, tx);
        await tx.faceCluster.deleteMany({ where: { id: { in: lightened }, personId: null, faces: { none: {} } } });
      });
    }
    // Unnamed clusters only: named ones are the matcher's business.
    const clusters = (await db.$queryRaw<{ id: string; centroid: string; faceCount: number }[]>`SELECT id, centroid::text AS centroid, "faceCount" FROM "FaceCluster" WHERE "personId" IS NULL AND centroid IS NOT NULL`).map((c) => ({ id: c.id, centroid: JSON.parse(c.centroid) as number[], faceCount: c.faceCount }));
    for (const f of found) {
      const hit = nearestCluster(f.embedding, clusters);
      await db.$transaction(async (tx) => {
        let clusterId: string | null = null;
        if (hit) {
          // The groups were read before this face was placed, and one may have been named since. Naming holds the
          // group's row while it works, so ask again under the same lock: a face never joins a named group, and so
          // somebody, without anybody saying so.
          const [row] = await tx.$queryRaw<{ personId: string | null; c: string | null; n: number }[]>`SELECT "personId", centroid::text AS c, "faceCount" AS n FROM "FaceCluster" WHERE id = ${hit.cluster.id} FOR UPDATE`;
          if (row && row.personId === null) {
            clusterId = hit.cluster.id;
            // The centre and count as they are now, not as read before the lock: a face carved out or split off
            // meanwhile has already been taken out of them.
            // A group whose faces have all lost their templates has no centre left, and this face becomes it.
            const next = row.c ? updatedCentroid(JSON.parse(row.c) as number[], row.n, f.embedding) : f.embedding;
            hit.cluster.centroid = next;
            hit.cluster.faceCount = row.n + 1;
            await tx.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(next)}::vector, "faceCount" = "faceCount" + 1, "updatedAt" = now() WHERE id = ${clusterId}`;
          } else clusters.splice(clusters.indexOf(hit.cluster), 1);
        }
        if (!clusterId) {
          const created = await tx.faceCluster.create({ data: { faceCount: 1 }, select: { id: true } });
          clusterId = created.id;
          await tx.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(f.embedding)}::vector WHERE id = ${clusterId}`;
          clusters.push({ id: clusterId, centroid: f.embedding, faceCount: 1 });
        }
        const face = await tx.face.create({ data: { photoId: photo.id, clusterId, box: f.box, confidence: f.confidence, ageAtCaptureYears: f.age, status: "DETECTED" }, select: { id: true } });
        await tx.$executeRaw`UPDATE "Face" SET embedding = ${vectorLiteral(f.embedding)}::vector WHERE id = ${face.id}`;
      });
    }
    await db.photo.update({ where: { id: photo.id }, data: { facesDetectedAt: new Date() } });
  }, signal);
  await proposeForPhoto(photo.id);
}

/**
 * Recompute a person's era centroids from the faces in each cluster (mean of unit vectors, renormalised in JS since
 * the running mean elsewhere assumes unit centroids), after templates were nulled and restored. Clusters that still
 * have no templates keep a NULL centroid.
 */
export async function rebuildCentroids(personId: string): Promise<void> {
  const rows = await db.$queryRaw<{ clusterId: string; c: string; n: number }[]>`
    SELECT f."clusterId", avg(f.embedding)::text AS c, count(*)::int AS n FROM "Face" f JOIN "FaceCluster" fc ON fc.id = f."clusterId"
    WHERE f.embedding IS NOT NULL AND fc."personId" = ${personId} GROUP BY f."clusterId"`;
  for (const r of rows) {
    const centroid = normalise(JSON.parse(r.c) as number[]);
    await db.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(centroid)}::vector, "faceCount" = ${r.n}, "updatedAt" = now() WHERE id = ${r.clusterId}`;
  }
  // Every open face may now match this person.
  const { enqueueMatchAllOpen } = await import("./match-photo");
  await enqueueMatchAllOpen();
}

/**
 * Recompute these unnamed clusters' centroids and counts from the faces they still hold, the same way rebuildCentroids
 * does for a person's eras. The count is every face in the cluster, as everywhere else; a cluster left with no
 * templates loses its centroid rather than keep one made of faces that are gone. Named clusters are left to the matcher.
 */
export async function rebuildUnnamedCentroids(clusterIds: string[], client: Prisma.TransactionClient = db): Promise<void> {
  if (!clusterIds.length) return;
  const rows = await client.$queryRaw<{ id: string; c: string | null; n: number }[]>`
    SELECT fc.id, (avg(f.embedding) FILTER (WHERE f.embedding IS NOT NULL))::text AS c, count(f.id)::int AS n
    FROM "FaceCluster" fc LEFT JOIN "Face" f ON f."clusterId" = fc.id
    WHERE fc."personId" IS NULL AND fc.id IN (${Prisma.join(clusterIds)}) GROUP BY fc.id`;
  for (const r of rows) {
    if (r.c === null) {
      await client.$executeRaw`UPDATE "FaceCluster" SET centroid = NULL, "faceCount" = ${r.n}, "updatedAt" = now() WHERE id = ${r.id}`;
      continue;
    }
    const centroid = normalise(JSON.parse(r.c) as number[]);
    await client.$executeRaw`UPDATE "FaceCluster" SET centroid = ${vectorLiteral(centroid)}::vector, "faceCount" = ${r.n}, "updatedAt" = now() WHERE id = ${r.id}`;
  }
}

/** Debounced like enqueueEmbedding: a second edit within the minute re-scans in the next one instead of being dropped. */
export async function enqueueFaceDetection(...photoIds: string[]): Promise<void> {
  const gates = await faceGates();
  if (!gates.active) return;
  for (const photoId of photoIds) await enqueue(QUEUES.detectFaces, { photoId }, { singletonKey: `faces:${photoId}`, singletonSeconds: 60, singletonNextSlot: true });
}

/** Catch-up: ready photos not yet scanned (photos and posters; clips use their poster). */
export async function faceSweep(): Promise<number> {
  const gates = await faceGates();
  if (!gates.active) return 0;
  const rows = await db.photo.findMany({ where: { ...NOT_TRASHED, status: "READY", facesDetectedAt: null, renditions: { not: Prisma.DbNull } }, select: { id: true }, orderBy: { createdAt: "desc" }, take: 100 });
  for (const r of rows) await enqueue(QUEUES.detectFaces, { photoId: r.id }, { singletonKey: `faces:${r.id}`, singletonSeconds: 60 });
  return rows.length;
}

/**
 * Faces nobody named (guests, bystanders) are not kept forever: purge them, and empty clusters, after the retention
 * window. Templates kept for a member-named person who is still waiting for an admin's decision are nulled after the
 * same window (the name and the boxes stay; a later "yes" re-scans the photos).
 */
export async function purgeUnnamedFaces(): Promise<number> {
  const gates = await faceGates();
  const cutoff = new Date(Date.now() - gates.retentionDays * 86_400_000);
  const res = await db.face.deleteMany({ where: { personId: null, createdAt: { lt: cutoff }, OR: [{ clusterId: null }, { cluster: { personId: null } }] } });
  await db.faceCluster.deleteMany({ where: { personId: null, faces: { none: {} } } });
  await db.$executeRaw`UPDATE "Face" f SET embedding = NULL FROM "Person" p WHERE p.id = f."personId" AND p."pendingDecision" AND NOT p."faceIndexing" AND f."createdAt" < ${cutoff} AND f.embedding IS NOT NULL`;
  await db.$executeRaw`UPDATE "FaceCluster" fc SET centroid = NULL FROM "Person" p WHERE p.id = fc."personId" AND p."pendingDecision" AND NOT p."faceIndexing" AND fc.centroid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Face" f WHERE f."clusterId" = fc.id AND f.embedding IS NOT NULL)`;
  return res.count;
}

/**
 * Nightly: people whose birthday now makes them adults, with recognition off and no admin decision on record, join
 * the "Needs a decision" list. Nothing is ever enabled here.
 */
export async function flagNewAdults(): Promise<number> {
  const { isMinor } = await import("@/lib/people/consent");
  const people = await db.person.findMany({ where: { kind: "HUMAN", faceIndexing: false, pendingDecision: false, adultAttestedAt: null, birthday: { not: null }, optedOutAt: null }, select: { id: true, birthday: true, faceIndexingSetAt: true } });
  // Adults now whose last recorded decision (if any) was taken while they were still minors.
  const adults = people.filter((p) => !isMinor(p) && (!p.faceIndexingSetAt || isMinor(p, p.faceIndexingSetAt)));
  if (adults.length) await db.person.updateMany({ where: { id: { in: adults.map((p) => p.id) } }, data: { pendingDecision: true } });
  return adults.length;
}
