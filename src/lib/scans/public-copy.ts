import type { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { storage } from "@/lib/storage";
import { scanShareable, type ScanFormat } from "@/lib/media/mime";
import { sanitizeScan } from "./sanitize";

type ScanFile = { storageKey: string; originalPath: string; scanFormat: string | null };

/** Where a scan's visitor copy is kept: beside the original, so deleting the item's folder takes it too. */
export function publicScanKey(scan: ScanFile): string {
  const ext = scan.originalPath.split(".").pop() ?? "bin";
  return `${scan.storageKey}/model-public.${ext}`;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/**
 * The key of the copy of this scan a visitor may have, made now if it has not been yet (at processing, or for a scan
 * uploaded before there were such copies, on the first visitor's request). Null when there is none to give: a format
 * that is never cleaned (USDZ), or a file that could not be.
 */
export async function publicScanCopy(scan: ScanFile): Promise<string | null> {
  if (!scanShareable(scan.scanFormat)) return null;
  const key = publicScanKey(scan);
  // Two visitors arriving together share one making of it: the file being written is never served half-written.
  const pending = making.get(key) ?? make(scan, key).finally(() => making.delete(key));
  making.set(key, pending);
  return pending;
}

const making = new Map<string, Promise<string | null>>();

async function make(scan: ScanFile, key: string): Promise<string | null> {
  const store = storage();
  if (await store.exists(key)) return key;
  const local = store.localPath?.(scan.originalPath);
  const original = local ? await readFile(local) : await readAll((await store.getStream(scan.originalPath)).stream);
  const cleaned = await sanitizeScan(scan.scanFormat as ScanFormat, original);
  if (!cleaned) return null;
  await store.putBuffer(key, cleaned);
  return key;
}
