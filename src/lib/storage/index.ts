import { env } from "@/lib/env";
import { LocalStorage } from "./local";
import type { StorageProvider } from "./types";

let instance: StorageProvider | undefined;

export function storage(): StorageProvider {
  if (!instance) {
    const e = env();
    switch (e.STORAGE_DRIVER) {
      case "local":
      default:
        instance = new LocalStorage(e.PHOTO_STORAGE_ROOT);
    }
  }
  return instance;
}

export type { StorageProvider } from "./types";
export { StorageLimitError } from "./types";
