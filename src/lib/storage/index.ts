import { env } from "@/lib/env";
import { LocalStorage } from "./local";
import { S3Objects } from "./s3";
import { TieredStorage } from "./tiered";
import type { StorageProvider } from "./types";

let instance: StorageProvider | undefined;

export function storage(): StorageProvider {
  if (!instance) {
    const e = env();
    switch (e.STORAGE_DRIVER) {
      case "tiered":
        // Originals move to S3 once processed (see ./tiered.ts and ./offload.ts); everything else stays on disk.
        instance = new TieredStorage(e.PHOTO_STORAGE_ROOT, new S3Objects(e.ORIGINALS_S3_BUCKET!), e.ORIGINALS_S3_PREFIX);
        break;
      case "local":
      default:
        instance = new LocalStorage(e.PHOTO_STORAGE_ROOT);
    }
  }
  return instance;
}

/**
 * A path on this machine holding the key's file, for libraries that read files (sharp, ffmpeg, EXIF): with the tiered
 * driver an original moved to S3 is fetched back first. Undefined for a store with no local files at all.
 */
export async function localFileOf(store: StorageProvider, key: string): Promise<string | undefined> {
  return store.localFile ? store.localFile(key) : store.localPath?.(key);
}

export type { StorageProvider } from "./types";
export { StorageLimitError } from "./types";
