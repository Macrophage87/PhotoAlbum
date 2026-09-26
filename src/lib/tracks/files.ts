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
