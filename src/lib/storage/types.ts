import type { Readable } from "node:stream";

export interface StorageProvider {
  /**
   * `onChunk` sees every chunk on its way to storage (to hash it, say) inside the same pipeline, so an error or an
   * abort anywhere in the chain settles the promise; a stage joined on with `.pipe()` would not pass one along.
   */
  putStream(key: string, body: Readable, opts?: { contentType?: string; maxBytes?: number; onChunk?: (chunk: Buffer) => void }): Promise<{ bytes: number }>;
  putBuffer(key: string, buf: Buffer, opts?: { contentType?: string }): Promise<void>;
  /** `range` is inclusive byte offsets, for video playback (HTTP 206). `size` is always the whole object's size. */
  getStream(key: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number }>;
  exists(key: string): Promise<boolean>;
  /** Put a finished object in place under another key, replacing any there, in one step: nobody sees half of it. */
  move(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Fast path for libraries that read files directly (sharp, parsers). Undefined for remote stores. */
  localPath?(key: string): string;
}

export class StorageLimitError extends Error {
  constructor(public maxBytes: number) {
    super(`Upload exceeds the limit of ${maxBytes} bytes`);
  }
}
