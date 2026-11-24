import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { storage, StorageLimitError } from "@/lib/storage";
import { decodeHeaderName } from "@/lib/media/header-name";
import { MAX_SONG_BYTES, SONG_TYPES, songTitle, songType } from "@/lib/music/songs";

export const dynamic = "force-dynamic";

/**
 * A member adds a song. The body is the file itself and its name rides in `x-file-name`, as an upload of a
 * photograph does. Nothing reads the file: it is kept as it came and played back as it is.
 */
export async function POST(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!request.body) return Response.json({ error: "That file is empty." }, { status: 422 });
  const fileName = decodeHeaderName(request.headers.get("x-file-name"));
  if (!fileName || fileName.length > 255) return Response.json({ error: "Bad upload headers" }, { status: 400 });
  const mime = songType(fileName, request.headers.get("content-type"));
  if (!mime) return Response.json({ error: "That is not a music file the TV can play. Use MP3, M4A, AAC, OGG, FLAC or WAV." }, { status: 415 });

  const song = await db.song.create({ data: { title: songTitle(fileName), path: "pending", mimeType: mime, sizeBytes: 0, uploaderId: viewer.user.id } });
  const path = `music/${song.id}/song.${SONG_TYPES[mime]}`;
  try {
    const body = Readable.fromWeb(request.body as never, { signal: request.signal });
    // A signal that fires before storage starts reading would otherwise crash the process (see the photo upload).
    body.on("error", () => {});
    const { bytes } = await storage().putStream(path, body, { contentType: mime, maxBytes: MAX_SONG_BYTES });
    if (bytes === 0) throw new Error("empty");
    const saved = await db.song.update({ where: { id: song.id }, data: { path, sizeBytes: bytes }, select: { id: true, title: true } });
    return Response.json({ id: saved.id, title: saved.title });
  } catch (error) {
    await storage().deletePrefix(`music/${song.id}`).catch(() => undefined);
    await db.song.delete({ where: { id: song.id } }).catch(() => {});
    if (error instanceof StorageLimitError) return Response.json({ error: `That file is too big. A song can be up to ${Math.round(MAX_SONG_BYTES / 1024 / 1024)} MB.` }, { status: 413 });
    if (error instanceof Error && error.message === "empty") return Response.json({ error: "That file is empty." }, { status: 422 });
    return Response.json({ error: "The song did not arrive whole. Try again." }, { status: 500 });
  }
}
