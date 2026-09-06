import type { Readable } from "node:stream";

export interface StorageProvider {
  putStream(key: string, body: Readable, opts?: { contentType?: string; maxBytes?: number }): Promise<{ bytes: number }>;
  putBuffer(key: string, buf: Buffer, opts?: { contentType?: string }): Promise<void>;
  getStream(key: string): Promise<{ stream: Readable; size: number }>;
  exists(key: string): Promise<boolean>;
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
