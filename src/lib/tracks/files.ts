import { db } from "@/lib/db";
import { storage } from "@/lib/storage";

/**
 * Delete uploaded track files (imports/…) that no track refers to any more. A GPX or FIT file with several tracks
 * in it stays until the last of them goes; a file that made no track at all goes at once.
 */
export async function forgetTrackFiles(keys: (string | null | undefined)[]): Promise<void> {
  for (const key of new Set(keys.filter((k): k is string => Boolean(k?.startsWith("imports/"))))) {
    if (await db.track.findFirst({ where: { originalFile: key }, select: { id: true } })) continue;
    await storage().delete(key).catch((err) => console.error(`[tracks] could not delete ${key}`, err));
  }
}

/**
 * Once, for albums from before Google exports were deleted after reading: forget the export behind every Google
 * track and delete the file. Run at worker start; after the first time there is nothing left for it to find.
 */
export async function forgetGoogleExports(): Promise<number> {
  const tracks = await db.track.findMany({ where: { source: "GOOGLE", originalFile: { not: null } }, select: { originalFile: true } });
  if (!tracks.length) return 0;
  await db.track.updateMany({ where: { source: "GOOGLE", originalFile: { not: null } }, data: { originalFile: null } });
  const keys = [...new Set(tracks.map((t) => t.originalFile))];
  await forgetTrackFiles(keys);
  console.log(`[tracks] deleted ${keys.length} Google export(s) kept from earlier imports`);
  return keys.length;
}
