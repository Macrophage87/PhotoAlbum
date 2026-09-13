import exifr from "exifr";
import { gpanoFrom, type GPano } from "./panorama";

/** The same, read from the file itself. XMP only: nothing here needs EXIF, and a bad packet must not fail an upload. */
export async function readGPano(input: string | Buffer): Promise<GPano> {
  try {
    const raw = (await exifr.parse(input, { xmp: true, tiff: false, exif: false, gps: false, mergeOutput: true })) as Record<string, unknown> | undefined;
    return gpanoFrom(raw);
  } catch {
    return null;
  }
}
