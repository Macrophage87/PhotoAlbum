import { db } from "@/lib/db";
import { oembed, YouTubeError } from "@/lib/video/youtube";
import { NOT_TRASHED } from "@/lib/photos/trash";

/**
 * Re-check every embedded video against oEmbed. A definite 401/403/404 marks it unavailable (deleted or made
 * private); network trouble leaves the row untouched so a YouTube outage never flags the whole library.
 */
export async function checkExternalVideos(): Promise<{ checked: number; unavailable: number }> {
  const videos = await db.photo.findMany({ where: { ...NOT_TRASHED, kind: "EXTERNAL_VIDEO", provider: "YOUTUBE", externalId: { not: null } }, select: { id: true, externalId: true } });
  let unavailable = 0;
  for (const v of videos) {
    try {
      const meta = await oembed(v.externalId!);
      await db.photo.update({ where: { id: v.id }, data: { externalStatus: "AVAILABLE", externalCheckedAt: new Date(), title: meta.title } });
    } catch (err) {
      if (err instanceof YouTubeError && err.code === "unavailable") {
        unavailable++;
        await db.photo.update({ where: { id: v.id }, data: { externalStatus: "UNAVAILABLE", externalCheckedAt: new Date() } });
      } else {
        console.warn(`[check-external-videos] ${v.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { checked: videos.length, unavailable };
}
