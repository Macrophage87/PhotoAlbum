import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { editsOf } from "@/lib/images/edits";
import { heicSource, isHeic } from "@/lib/images/heic";
import { findVisitorCopy, planVisitorCopy, renderVisitorCopy, VISITOR_FILE, visitorStem } from "@/lib/images/visitor-copy";
import { forgetFilesIfGone } from "@/lib/storage/sweep";
import { withHeavyLock } from "../heavy-lock";
import type { VisitorCopyJob } from "../queues";

/**
 * Make a photograph's full-size copy for visitors (see `lib/images/visitor-copy`), one at a time and under the heavy
 * lock: however large the picture, only one is being made at once. Writes nothing on the row: the copy is a file
 * beside the original, named for the picture it was made from, written under a name of its own and moved into place
 * whole. Older copies go, with the notes and half-written files of older makings; once it is there, so does
 * anything else of the same picture's.
 */
export async function makeVisitorCopy(job: VisitorCopyJob, signal?: AbortSignal): Promise<void> {
  const photo = await db.photo.findUnique({ where: { id: job.photoId }, select: { id: true, kind: true, storageKey: true, originalPath: true, originalName: true, mimeType: true, edits: true, imageVersion: true, renditions: true } });
  // Gone, or changed since it was asked for: whoever asks about the picture as it is now queues that one. An edited
  // photo is still copied (it may be waiting on its re-render), but one that is not processed yet has nothing to show.
  if (!photo || photo.kind !== "PHOTO" || !photo.renditions || photo.imageVersion !== job.imageVersion) return;
  const store = storage();
  const local = store.localPath?.(photo.originalPath);
  if (!local) return;
  if (await findVisitorCopy(photo)) return;
  // What was made of the picture before it last changed is never looked for again, and a making that died part-way
  // left what it was writing.
  await forgetVisitorFiles(photo.storageKey, photo.imageVersion);

  const stem = visitorStem(photo);
  const tmp = `${stem}.${randomUUID()}.tmp`;
  let kept: string;
  try {
    kept = await withHeavyLock(async () => {
      const edits = editsOf(photo.edits);
      // A HEIC is decoded as its renditions were: sharp cannot read one, and the file's own bytes are never passed on.
      const input = isHeic(photo.mimeType, photo.originalName) ? await heicSource(store, photo.storageKey, local) : local;
      const plan = await planVisitorCopy(input, edits);
      if (!plan) {
        await store.putBuffer(`${stem}.withheld`, Buffer.from("too big to copy safely"));
        return `${stem}.withheld`;
      }
      signal?.throwIfAborted();
      // Straight into the item's folder, which is there while the item is: deleted meanwhile, the write fails
      // rather than making the folder again.
      await renderVisitorCopy(input, edits, plan, store.localPath!(tmp));
      signal?.throwIfAborted();
      await store.move(tmp, `${stem}.${plan.ext}`);
      return `${stem}.${plan.ext}`;
    }, signal);
  } catch (err) {
    await store.delete(tmp).catch(() => undefined);
    // Deleted for good while it was being made: nothing to note, and nothing to try again.
    if (await forgetFilesIfGone(photo.id)) return;
    // Noted, so visitors asking meanwhile are given the largest rendition rather than queueing it again and again;
    // pg-boss still retries it a couple of times.
    await store.putBuffer(`${stem}.failed`, Buffer.from(String(err).slice(0, 500))).catch(() => undefined);
    throw err;
  }
  if (await forgetFilesIfGone(photo.id)) return;
  await forgetVisitorFiles(photo.storageKey, photo.imageVersion, kept);
}

/**
 * Delete the item's visitor files from before `version`, and with `keep`, every other one of that version too. A
 * newer version's are left alone: a making of it may have finished first, and its copy is the one being served.
 */
async function forgetVisitorFiles(storageKey: string, version: number, keep?: string): Promise<void> {
  const store = storage();
  const dir = store.localPath?.(storageKey);
  if (!dir) return;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = VISITOR_FILE.exec(name);
    if (!m) continue;
    const of = Number(m[1]);
    if (of < version || (keep && of === version && name !== path.basename(keep))) await store.delete(`${storageKey}/${name}`).catch(() => undefined);
  }
}
