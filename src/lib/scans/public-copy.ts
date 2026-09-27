import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { storage } from "@/lib/storage";
import { scanShareable, type ScanFormat } from "@/lib/media/mime";
import { PLY_HEADER_MAX, PlyWithheld, plyFixedLength, plyHeader, plyTextBody, sanitizeScan } from "./sanitize";

type ScanFile = { storageKey: string; originalPath: string; scanFormat: string | null };

/**
 * Which cleaning a copy was made by. Raise it whenever `sanitize` changes what a copy keeps: a copy (or a refusal)
 * made by an older one is then made again on the next request, and the old one deleted, rather than handed out.
 */
export const PUBLIC_SCAN_VERSION = 2;

/** A scan's visitor copy under a cleaning's version; the first had no version in its name. */
const copyKey = (scan: ScanFile, version: number) => {
  const ext = scan.originalPath.split(".").pop() ?? "bin";
  return `${scan.storageKey}/model-public${version === 1 ? "" : `-v${version}`}.${ext}`;
};

/** Where a scan's visitor copy is kept: beside the original, so deleting the item's folder takes it too. */
export function publicScanKey(scan: ScanFile): string {
  return copyKey(scan, PUBLIC_SCAN_VERSION);
}

/**
 * Where it is written down that a scan has no visitor copy, and why, so a file that cannot be cleaned is found to be
 * so once rather than on every visitor's request.
 */
export function withheldScanKey(scan: ScanFile, version = PUBLIC_SCAN_VERSION): string {
  return `${scan.storageKey}/model-public-v${version}.withheld`;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/**
 * The key of the copy of this scan a visitor may have, made now if it has not been yet (at processing, or for a scan
 * uploaded before there were such copies, or made by an older cleaning, on the first visitor's request). Null when
 * there is none to give: a format that is never cleaned (USDZ), or a file that could not be, which is remembered.
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
  const withheld = withheldScanKey(scan);
  if (await store.exists(withheld)) return null;
  // Written under a name of its own and moved into place whole, so a crash part-way never leaves a file that
  // looks finished; a leftover goes with the item's folder.
  const tmp = `${key}.${randomUUID()}.tmp`;
  try {
    // An error reading or writing storage is not an answer about the file, so nothing is written down for it.
    const reason = await write(scan, tmp);
    if (reason) await store.putBuffer(withheld, Buffer.from(JSON.stringify({ version: PUBLIC_SCAN_VERSION, reason })));
    else await store.move(tmp, key);
    // What an older cleaning made, or refused, is not handed out again.
    for (let v = 1; v < PUBLIC_SCAN_VERSION; v++) {
      await store.delete(copyKey(scan, v));
      await store.delete(withheldScanKey(scan, v));
    }
    return reason ? null : key;
  } finally {
    await store.delete(tmp).catch(() => undefined);
  }
}

/** Write the cleaned copy to `tmp`; the reason there is none to give, when there is not. */
async function write(scan: ScanFile, tmp: string): Promise<string | null> {
  const store = storage();
  if (scan.scanFormat === "PLY") {
    // A binary PLY of fixed-size records (what splats are, and they run to gigabytes) is cleaned in its header alone
    // and its size is known from it, so the records are streamed across untouched and whatever follows them is not.
    const { stream: first, size } = await store.getStream(scan.originalPath, { start: 0, end: PLY_HEADER_MAX - 1 });
    const layout = plyHeader(await readAll(first));
    if (!layout) return "a PLY header this cannot rebuild";
    const fixed = plyFixedLength(layout);
    if (fixed !== null) {
      if (layout.bodyStart + fixed > size) return "fewer records than its header declares";
      const rest = fixed > 0 ? (await store.getStream(scan.originalPath, { start: layout.bodyStart, end: layout.bodyStart + fixed - 1 })).stream : null;
      await store.putStream(tmp, Readable.from((async function* () {
        yield layout.header;
        if (rest) yield* rest;
      })()));
      return null;
    }
    if (layout.format === "ascii") {
      // Text is made again record by record as it streams across, so a big one is never all in memory, and the server
      // gets its turn between batches rather than waiting on the whole file.
      const rest = layout.bodyStart < size ? (await store.getStream(scan.originalPath, { start: layout.bodyStart, end: size - 1 })).stream : [];
      try {
        await store.putStream(tmp, Readable.from((async function* () {
          yield layout.header;
          yield* plyTextBody(layout, rest);
        })()));
      } catch (err) {
        if (err instanceof PlyWithheld) return err.message;
        throw err;
      }
      return null;
    }
    // Binary records with lists in them: their length is found by reading them, below.
  }
  const local = store.localPath?.(scan.originalPath);
  const original = local ? await readFile(local) : await readAll((await store.getStream(scan.originalPath)).stream);
  const cleaned = await sanitizeScan(scan.scanFormat as ScanFormat, original);
  if (!cleaned) return `not a ${scan.scanFormat} this can clean with confidence`;
  await store.putBuffer(tmp, cleaned);
  return null;
}
