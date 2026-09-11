import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** sha256 of a file on disk, streamed; the album's duplicate check across uploads and imports. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
