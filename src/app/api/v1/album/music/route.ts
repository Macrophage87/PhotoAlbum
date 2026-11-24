import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { songCastUrl } from "@/lib/music/songs";

export const dynamic = "force-dynamic";

/**
 * The album's songs for the app, newest first, each with an address a television can fetch for the next few hours.
 * The app tells the television which to play under a slideshow.
 */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const songs = await db.song.findMany({ where: { path: { not: "pending" } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { id: true, title: true } });
  const now = Date.now();
  return Response.json({ songs: await Promise.all(songs.map(async (s) => ({ id: s.id, title: s.title, cast: await songCastUrl(s.id, now) }))) });
}
