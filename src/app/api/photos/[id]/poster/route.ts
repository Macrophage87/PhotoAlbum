import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canEditMedia } from "@/lib/auth/ownership";
import { storage } from "@/lib/storage";
import { makeRenditions } from "@/lib/images/renditions";

export const dynamic = "force-dynamic";

/** A still is worth about this much on a tile; anything larger is the viewer sending more than a grid can use. */
const MAX_POSTER_BYTES = 4 * 1024 * 1024;

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

  const store = storage();
  const { width, height, renditions } = await makeRenditions(Buffer.from(body), photo.storageKey, (key, buf) => store.putBuffer(key, buf));
  await db.photo.update({ where: { id: photo.id }, data: { width, height, renditions } });
  return Response.json({ ok: true });
}
