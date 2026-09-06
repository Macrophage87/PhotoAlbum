import { readFile } from "node:fs/promises";
import sharp from "sharp";

export function isHeic(mimeType: string, fileName: string): boolean {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return mimeType === "image/heic" || mimeType === "image/heif" || ext === "heic" || ext === "heif";
}

/**
 * Returns a sharp-readable buffer for a HEIC file. Tries sharp's libheif first; when the
 * build lacks an HEVC decoder (common for prebuilt binaries), falls back to the WASM decoder.
 */
export async function heicToJpegBuffer(filePath: string): Promise<Buffer> {
  try {
    return await sharp(filePath).rotate().jpeg({ quality: 92 }).toBuffer();
  } catch {
    const { default: heicConvert } = await import("heic-convert");
    const input = await readFile(filePath);
    const out = await heicConvert({ buffer: input, format: "JPEG", quality: 0.92 });
    return Buffer.from(out);
  }
}
