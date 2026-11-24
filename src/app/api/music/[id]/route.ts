import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { isAdmin } from "@/lib/auth/ownership";
import { storage } from "@/lib/storage";
import { songLinkGood } from "@/lib/music/songs";
import { MEDIA_CSP } from "@/lib/security/csp";
import { parseRange } from "@/app/api/photos/[id]/[size]/route";

export const dynamic = "force-dynamic";

/**
 * A song's bytes: for a member, or for a television holding the address the album signed for it (`?cast=`).
 * Nobody else. Whole, or the one range asked for, since a player seeks.
 */
export async function GET(request: Request, { params }: RouteContext<"/api/music/[id]">) {
  const { id } = await params;
  const cast = new URL(request.url).searchParams.get("cast");
  const allowed = (cast !== null && (await songLinkGood(id, cast))) || (await getApiViewer(request)).kind === "user";
  if (!allowed) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const song = await db.song.findUnique({ where: { id }, select: { path: true, mimeType: true } });
  if (!song || song.path === "pending") return Response.json({ error: "Not found" }, { status: 404 });

  const store = storage();
  let whole;
  try {
    whole = await store.getStream(song.path);
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const headers: Record<string, string> = { "Content-Type": song.mimeType, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "Content-Security-Policy": MEDIA_CSP };
  const range = parseRange(request.headers.get("range"), whole.size);
  if (range === "invalid") {
    whole.stream.destroy();
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${whole.size}` } });
  }
  if (range) {
    whole.stream.destroy();
    const part = await store.getStream(song.path, range);
    headers["Content-Length"] = String(range.end - range.start + 1);
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${whole.size}`;
    return new Response(Readable.toWeb(part.stream) as ReadableStream, { status: 206, headers });
  }
  headers["Content-Length"] = String(whole.size);
  return new Response(Readable.toWeb(whole.stream) as ReadableStream, { headers });
}

/** Whoever added a song, or an admin, takes it out again. */
export async function DELETE(request: Request, { params }: RouteContext<"/api/music/[id]">) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const song = await db.song.findUnique({ where: { id }, select: { id: true, uploaderId: true } });
  if (!song) return Response.json({ error: "Not found" }, { status: 404 });
  if (song.uploaderId !== viewer.user.id && !isAdmin(viewer.user)) return Response.json({ error: "Only the family member who added this song, or an admin, can remove it." }, { status: 403 });
  await db.song.delete({ where: { id } });
  await storage().deletePrefix(`music/${id}`).catch(() => undefined);
  return Response.json({ ok: true });
}
