import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canEditMedia } from "@/lib/auth/ownership";
import { storage } from "@/lib/storage";
import { makeRenditions } from "@/lib/images/renditions";
import { stillIsBlank } from "@/lib/images/poster";
import sharp from "sharp";

export const dynamic = "force-dynamic";

/**
 * A still arrives as a PNG, which keeps its transparency but is far bigger than the same picture as a JPEG — a wide
 * screen at twice the pixel density can send several megabytes. Nothing of it is kept: the renditions are made and
 * the upload is dropped, so the limit is only there to stop something absurd.
 */
const MAX_POSTER_BYTES = 16 * 1024 * 1024;

/**
 * The picture a 3D scan shows in the grids.
 *
 * A scan has no pixels of its own: the file is geometry, and nothing on the server can draw it without a graphics
 * card. The first member to open one has already drawn it, though — their browser has the scan on screen — so it
 * sends back a still of what it drew, and from then on the album has a tile for it like anything else. Only
 * somebody who may change the item may do this, and only once: a poster already taken is left alone.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, select: { id: true, uploaderId: true, kind: true, storageKey: true, renditions: true } });
  if (!photo || photo.kind !== "SCAN") return Response.json({ error: "Not a scan" }, { status: 404 });
  if (!canEditMedia(user, photo)) return Response.json({ error: "Not yours" }, { status: 403 });
  if (photo.renditions) return Response.json({ ok: true, already: true });

  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_POSTER_BYTES) return Response.json({ error: "Bad poster" }, { status: 400 });

  // A still of nothing is worse than none: it would be kept for good and the album would never ask again. The
  // browser checks before sending, but only the server can be trusted to decide what is stored.
  const still = Buffer.from(body);
  const { channels } = await sharp(still).stats().catch(() => ({ channels: [] }));
  if (stillIsBlank(channels)) return Response.json({ error: "The scan had not been drawn yet" }, { status: 422 });

  const store = storage();
  const { width, height, renditions } = await makeRenditions(still, photo.storageKey, (key, buf) => store.putBuffer(key, buf));
  await db.photo.update({ where: { id: photo.id }, data: { width, height, renditions } });
  return Response.json({ ok: true });
}
