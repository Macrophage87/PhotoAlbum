import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { storage } from "@/lib/storage";
import { scanShareable, type ScanFormat } from "@/lib/media/mime";
import { PLY_HEADER_MAX, plyFixedLength, plyHeader, sanitizeScan } from "./sanitize";

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
  // Two visitors arriving together share one making of it.
  const pending = making.get(key) ?? make(scan, key).finally(() => making.delete(key));
  making.set(key, pending);
  return pending;
}

const making = new Map<string, Promise<string | null>>();

async function make(scan: ScanFile, key: string): Promise<string | null> {
  const store = storage();
  if (await store.exists(key)) return key;
  // Written under a name of its own and moved into place whole, so a crash part-way never leaves a file that
  // looks finished; a leftover goes with the item's folder.
  const tmp = `${key}.${randomUUID()}.tmp`;
  try {
    if (!(await write(scan, tmp))) return null;
    await store.move(tmp, key);
    return key;
  } finally {
    await store.delete(tmp).catch(() => undefined);
  }
}

/** Write the cleaned copy to `tmp`; false when there is none to write. */
async function write(scan: ScanFile, tmp: string): Promise<boolean> {
  const store = storage();
  if (scan.scanFormat === "PLY") {
    // A binary PLY of fixed-size records (what splats are, and they run to gigabytes) is cleaned in its header alone
    // and its size is known from it, so the records are streamed across untouched and whatever follows them is not.
    const { stream: first, size } = await store.getStream(scan.originalPath, { start: 0, end: PLY_HEADER_MAX - 1 });
    const layout = plyHeader(await readAll(first));
    if (!layout) return false;
    const fixed = plyFixedLength(layout);
    if (fixed !== null) {
      if (layout.bodyStart + fixed > size) return false;
      const rest = fixed > 0 ? (await store.getStream(scan.originalPath, { start: layout.bodyStart, end: layout.bodyStart + fixed - 1 })).stream : null;
      await store.putStream(tmp, Readable.from((async function* () {
        yield layout.header;
        if (rest) yield* rest;
      })()));
      return true;
    }
    // Text, or records with lists in them: their length is found by reading them, below.
  }
  const local = store.localPath?.(scan.originalPath);
  const original = local ? await readFile(local) : await readAll((await store.getStream(scan.originalPath)).stream);
  const cleaned = await sanitizeScan(scan.scanFormat as ScanFormat, original);
  if (!cleaned) return false;
  await store.putBuffer(tmp, cleaned);
  return true;
}
