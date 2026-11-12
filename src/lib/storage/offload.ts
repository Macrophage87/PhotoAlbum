import { stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { storage } from "@/lib/storage";
import { installIdentity } from "./identity";
import type { RemoteClass } from "./remote";
import { TieredStorage } from "./tiered";

/** Items whose original is worth moving: uploads. An external video's "original" is a poster that is written over. */
const KINDS = ["PHOTO", "VIDEO", "SCAN"];
/** Originals moved per run, so one run over a big album's backlog stays well inside a job's time. */
export const OFFLOAD_BATCH = 300;

export type OffloadResult = { offloaded: number; recorded: number; evicted: number; failed: number };

type Candidate = { id: string; originalPath: string; mimeType: string; createdAt: Date };

/**
 * Option 2's hourly pass (STORAGE_DRIVER=tiered; does nothing otherwise):
 *
 * 1. Originals of items processed (READY) and left alone for ORIGINALS_OFFLOAD_AFTER_HOURS go up to S3 — Standard,
 *    or straight to Glacier Instant Retrieval for one uploaded longer ago than the lifecycle's age, which is how an
 *    existing album's backlog is moved — and are recorded in OriginalCopy once S3 is seen to hold all of the bytes.
 * 2. Then the disk's copy is deleted, unless the item went back to processing meanwhile.
 * 3. Copies fetched back from S3 for work (a re-render, a visitor copy, a re-transcode) are deleted again once that
 *    long has passed since the fetch.
 *
 * Nothing runs unless the storage root is this database's (see identity.ts): a database that is not this media's
 * would otherwise delete files on the say-so of rows that describe somebody else's.
 */
export async function offloadOriginals(now = new Date(), batch = OFFLOAD_BATCH): Promise<OffloadResult> {
  const result: OffloadResult = { offloaded: 0, recorded: 0, evicted: 0, failed: 0 };
  const store = storage();
  if (!(store instanceof TieredStorage)) return result;
  const identity = await installIdentity(now);
  if (!identity.ok) {
    console.error(`[offload] not moving originals to S3: ${identity.problem}`);
    return result;
  }
  const e = env();
  const settled = new Date(now.getTime() - e.ORIGINALS_OFFLOAD_AFTER_HOURS * 3600_000);
  const glacierAfter = new Date(now.getTime() - e.ORIGINALS_GLACIER_AFTER_DAYS * 86400_000);

  const candidates = await db.$queryRaw<Candidate[]>`
    SELECT p.id, p."originalPath", p."mimeType", p."createdAt"
    FROM "Photo" p LEFT JOIN "OriginalCopy" c ON c."photoId" = p.id
    WHERE p.status = 'READY' AND p.kind::text = ANY(${KINDS}::text[]) AND p."originalPath" <> 'pending'
      AND p."updatedAt" < ${settled} AND (c."photoId" IS NULL OR c.key <> p."originalPath")
    ORDER BY p."createdAt"
    LIMIT ${batch}`;

  for (const c of candidates) {
    try {
      const onDisk = await stat(store.localPath(c.originalPath)).then((s) => s.isFile(), () => false);
      let bytes: number;
      let storageClass: string;
      if (onDisk) {
        storageClass = c.createdAt < glacierAfter ? "GLACIER_IR" : "STANDARD";
        bytes = await store.offload(c.originalPath, { storageClass: storageClass as RemoteClass, contentType: c.mimeType });
        result.offloaded++;
      } else {
        // Up already (a run that died before recording it), or lost: only the first can be recorded.
        const head = await store.remoteHead(c.originalPath);
        if (!head) {
          console.error(`[offload] ${c.id}: its original ${c.originalPath} is neither on disk nor in S3`);
          result.failed++;
          continue;
        }
        bytes = head.size;
        storageClass = head.storageClass;
        result.recorded++;
      }
      await db.originalCopy.upsert({
        where: { photoId: c.id },
        create: { photoId: c.id, key: c.originalPath, bytes: BigInt(bytes), storageClass },
        update: { key: c.originalPath, bytes: BigInt(bytes), storageClass, storedAt: now },
      });
      if (onDisk && (await stillSettled(c.id, c.originalPath)) && (await store.evict(c.originalPath))) result.evicted++;
    } catch (err) {
      result.failed++;
      console.error(`[offload] could not move the original of ${c.id} to S3`, err);
    }
  }

  result.evicted += await evictFetchedCopies(store, settled);
  if (result.offloaded || result.recorded || result.evicted || result.failed) console.log(`[offload] ${result.offloaded} original(s) moved to S3, ${result.recorded} found there already, ${result.evicted} disk copies freed, ${result.failed} failed`);
  return result;
}

/** Processing that began since the item was picked reads the disk's copy: leave it there for the next run. */
async function stillSettled(id: string, originalPath: string): Promise<boolean> {
  const now = await db.photo.findUnique({ where: { id }, select: { status: true, originalPath: true } });
  return now?.status === "READY" && now.originalPath === originalPath;
}

/** Copies on disk of originals S3 already holds, fetched back (or left by an earlier run) longer ago than `before`. */
async function evictFetchedCopies(store: TieredStorage, before: Date): Promise<number> {
  let evicted = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await db.originalCopy.findMany({
      take: 500,
      ...(cursor ? { skip: 1, cursor: { photoId: cursor } } : {}),
      orderBy: { photoId: "asc" },
      select: { photoId: true, key: true, photo: { select: { status: true, originalPath: true } } },
    });
    if (!page.length) return evicted;
    cursor = page[page.length - 1].photoId;
    for (const row of page) {
      if (row.photo.status !== "READY" || row.photo.originalPath !== row.key) continue;
      // ctime, not mtime: a fetched copy gets its file's own modified time back, but its change time is the fetch.
      const s = await stat(store.localPath(row.key)).catch(() => null);
      if (!s || s.ctime >= before) continue;
      if (await store.evict(row.key).catch(() => false)) evicted++;
    }
  }
}
