import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StorageLimitError, type StorageProvider } from "./types";

function assertSafeKey(key: string) {
  if (key.includes("..") || path.isAbsolute(key) || key.includes("\0")) throw new Error(`Unsafe storage key: ${key}`);
}

export class LocalStorage implements StorageProvider {
  constructor(private root: string) {}

  localPath(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, key);
  }

  async putStream(key: string, body: Readable, opts?: { maxBytes?: number }): Promise<{ bytes: number }> {
    const file = this.localPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    let bytes = 0;
    const max = opts?.maxBytes;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (max !== undefined && bytes > max) return cb(new StorageLimitError(max));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(file));
    } catch (err) {
      await rm(file, { force: true });
      throw err;
    }
    return { bytes };
  }

  async putBuffer(key: string, buf: Buffer): Promise<void> {
    const file = this.localPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buf);
  }

  async getStream(key: string) {
    const file = this.localPath(key);
    const s = await stat(file);
    return { stream: createReadStream(file), size: s.size };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    // Never allow the storage root itself (or a bare top-level folder) to be removed.
    const parts = prefix.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Refusing to delete prefix "${prefix}": expected at least "<folder>/<id>"`);
    await rm(this.localPath(prefix), { recursive: true, force: true });
  }
}
