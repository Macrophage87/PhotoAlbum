import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { RemoteMissingError, type RemoteClass, type RemoteObjects } from "@/lib/storage/remote";

/** An in-memory bucket, standing in for S3 in tests. */
export class FakeRemote implements RemoteObjects {
  objects = new Map<string, { body: Buffer; storageClass: string; mtimeMs?: number }>();
  /** Set to make the next upload land short, as a cut-off transfer would without S3's checksums. */
  truncateNext = false;

  async upload(key: string, file: string, opts: { storageClass: RemoteClass; mtimeMs?: number }) {
    let body = await readFile(file);
    if (this.truncateNext) {
      this.truncateNext = false;
      body = body.subarray(0, Math.max(0, body.length - 1));
    }
    this.objects.set(key, { body, storageClass: opts.storageClass, mtimeMs: opts.mtimeMs });
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, storageClass: o.storageClass, mtimeMs: o.mtimeMs } : null;
  }
  async get(key: string, range?: { start: number; end: number }) {
    const o = this.objects.get(key);
    if (!o) throw new RemoteMissingError(key);
    return { stream: Readable.from([range ? o.body.subarray(range.start, range.end + 1) : o.body]), size: o.body.length };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deletePrefix(prefix: string) {
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) this.objects.delete(k);
  }
}
