import type { Readable } from "node:stream";

/** The S3 storage classes the album writes originals in. Lifecycle rules move STANDARD to GLACIER_IR later. */
export type RemoteClass = "STANDARD" | "GLACIER_IR";

/**
 * Objects kept off the server's disk, by full remote key. S3 in production (./s3.ts); an in-memory stand-in in tests.
 * Only the tiered driver talks to this.
 */
export interface RemoteObjects {
  /** Upload a whole local file. `mtimeMs` is kept with the object, so a copy fetched back keeps the file's own time. */
  upload(key: string, file: string, opts: { storageClass: RemoteClass; contentType?: string; mtimeMs?: number }): Promise<void>;
  /** Null when there is no such object. */
  head(key: string): Promise<{ size: number; storageClass: string; mtimeMs?: number } | null>;
  /** `range` is inclusive byte offsets. `size` is always the whole object's size. Rejects with code ENOENT when missing. */
  get(key: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number }>;
  delete(key: string): Promise<void>;
  /** Every object whose key starts with `prefix`, which always ends in "/". */
  deletePrefix(prefix: string): Promise<void>;
}

export class RemoteMissingError extends Error {
  code = "ENOENT";
  constructor(key: string) {
    super(`No object at ${key} in remote storage`);
  }
}
