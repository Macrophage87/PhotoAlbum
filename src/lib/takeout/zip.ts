import yauzl from "yauzl";
import type { Readable } from "node:stream";

export type ZipEntry = { path: string; size: number; isDirectory: boolean };

/**
 * Walk a zip lazily, entry by entry, without loading it into memory. The callback may open the entry's stream; the
 * next entry is read only after the callback resolves, so at most one file is in flight.
 */
export async function walkZip(file: string, onEntry: (entry: ZipEntry, open: () => Promise<Readable>) => Promise<void>): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, z) => (err ? reject(err) : resolve(z))));
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve());
    zip.on("entry", (entry: yauzl.Entry) => {
      const isDirectory = /\/$/.test(entry.fileName);
      const open = () => new Promise<Readable>((res, rej) => zip.openReadStream(entry, (err, stream) => (err ? rej(err) : res(stream))));
      onEntry({ path: entry.fileName, size: entry.uncompressedSize, isDirectory }, open)
        .then(() => zip.readEntry())
        .catch((err) => { zip.close(); reject(err); });
    });
    zip.readEntry();
  });
}

export async function readStreamToString(stream: Readable, max = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    n += (chunk as Buffer).length;
    if (n > max) throw new Error("sidecar too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
