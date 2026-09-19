import type { Readable } from "node:stream";
import sharp from "sharp";
import { storage } from "@/lib/storage";

/** Link-preview JPEGs are read by crawlers, not people; this is plenty and keeps the card inside every size limit. */
const PREVIEW_QUALITY = 82;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/**
 * The same picture the album shows, re-encoded as JPEG for a link preview.
 *
 * Everything stored here is WebP, which is smaller and which every browser has drawn for years. What draws link
 * previews is not a browser: Facebook, Messenger and WhatsApp read the card's picture with their own crawlers, and
 * those still show nothing at all for a WebP `og:image`. So the card gets a format from 2005, made when it is
 * asked for rather than stored, because it is fetched once per link that anybody actually sends.
 */
export async function jpegPreview(key: string): Promise<Buffer> {
  const store = storage();
  const local = store.localPath?.(key);
  const input = local ?? (await readAll((await store.getStream(key)).stream));
  return sharp(input).jpeg({ quality: PREVIEW_QUALITY, mozjpeg: true }).toBuffer();
}
