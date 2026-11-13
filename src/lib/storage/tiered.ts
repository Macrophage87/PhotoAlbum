import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertSafeKey, LocalStorage } from "./local";
import type { RemoteClass, RemoteObjects } from "./remote";

function isEnoent(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT";
}

/**
 * Option 2 storage: everything is written to the server's disk as before, and originals are later moved to S3 by the
 * offload job (./offload.ts), which then frees the disk. S3's own lifecycle rule moves an original from Standard to
 * Glacier Instant Retrieval 90 days after it arrived there; both are read the same way, at once.
 *
 * The disk is always tried first. Reading an original that is only in S3 streams it from there (a download, a 3D
 * scan); work that needs a file on disk (sharp, ffmpeg, EXIF) asks `localFile`, which fetches a copy back. That copy
 * is a cache: the offload job deletes it again once nothing has fetched it for a while.
 *
 * Renditions, posters, visitor copies and track files never leave the disk. Deleting a key or a prefix deletes it in
 * both places. With S3 versioning on (the CloudFormation template does this), a deleted original can be recovered
 * for 30 days.
 */
export class TieredStorage extends LocalStorage {
  constructor(
    root: string,
    readonly remote: RemoteObjects,
    /** Ends in "/": keeps one install's originals apart from another's in a shared bucket (live/, staging/). */
    readonly prefix: string,
  ) {
    super(root);
    if (!prefix.endsWith("/")) throw new Error(`The remote prefix must end in "/" (got "${prefix}")`);
  }

  remoteKey(key: string): string {
    assertSafeKey(key);
    return `${this.prefix}${key}`;
  }

  override async getStream(key: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number }> {
    try {
      return await super.getStream(key, range);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      return this.remote.get(this.remoteKey(key), range);
    }
  }

  override async exists(key: string): Promise<boolean> {
    return (await super.exists(key)) || (await this.remote.head(this.remoteKey(key))) !== null;
  }

  override async delete(key: string): Promise<void> {
    await super.delete(key);
    await this.remote.delete(this.remoteKey(key));
  }

  override async deletePrefix(prefix: string): Promise<void> {
    await super.deletePrefix(prefix);
    // "photos/abc" must never take "photos/abcd" with it.
    await this.remote.deletePrefix(`${this.remoteKey(prefix.replace(/\/+$/, ""))}/`);
  }

  async localFile(key: string): Promise<string> {
    const file = this.localPath(key);
    if (await stat(file).then((s) => s.isFile(), () => false)) return file;
    const remoteKey = this.remoteKey(key);
    const head = await this.remote.head(remoteKey);
    const { stream } = await this.remote.get(remoteKey);
    await mkdir(path.dirname(file), { recursive: true });
    // Fetched beside its place and renamed into it, so nothing ever reads half a file; two fetches at once both win.
    const part = `${file}.fetch-${randomUUID()}`;
    try {
      await pipeline(stream, createWriteStream(part));
      // The file's own time, which processing falls back on for a date, comes back with it. Its change time (ctime)
      // is now, which is what the cache is aged by.
      if (head?.mtimeMs) await utimes(part, new Date(), new Date(head.mtimeMs));
      await rename(part, file);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    return file;
  }

  /** Whether S3 holds the key; the size it holds, to compare with the disk's. */
  async remoteHead(key: string) {
    return this.remote.head(this.remoteKey(key));
  }

  /** Copy the key's file on disk to S3, and check S3 then holds as many bytes. Returns that size. */
  async offload(key: string, opts: { storageClass: RemoteClass; contentType?: string }): Promise<number> {
    const file = this.localPath(key);
    const s = await stat(file);
    await this.remote.upload(this.remoteKey(key), file, { ...opts, mtimeMs: s.mtimeMs });
    const head = await this.remote.head(this.remoteKey(key));
    if (!head || head.size !== s.size) throw new Error(`S3 holds ${head ? `${head.size} bytes` : "nothing"} for ${key}, not the ${s.size} on disk`);
    return s.size;
  }

  /**
   * Delete the copy on disk, but only once S3 is seen to hold the same number of bytes: the disk is never the
   * last place an original was. True when it was deleted.
   */
  async evict(key: string): Promise<boolean> {
    const file = this.localPath(key);
    const s = await stat(file).catch(() => null);
    if (!s) return false;
    const head = await this.remote.head(this.remoteKey(key));
    if (!head || head.size !== s.size) return false;
    await rm(file, { force: true });
    return true;
  }
}
