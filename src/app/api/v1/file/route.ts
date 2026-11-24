import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { fileExisting } from "@/lib/photos/file-existing";

export const dynamic = "force-dynamic";

const id = z.string().min(1).max(100);
const schema = z.object({ photoIds: z.array(id).min(1).max(200), tripId: id.nullish(), activityId: id.nullish(), collectionId: id.nullish() });

/**
 * Puts photographs already in the album on a trip, on one of its activities, or in a collection, from the app: what
 * the website's "Add to…" does for a selection. The usual rule holds for each one: only whoever added it, or an
 * admin, may move it, and the rest are counted and left where they are.
 */
export async function POST(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose some photos, and where to put them." }, { status: 400 });
  const { tripId, activityId, collectionId } = parsed.data;
  if (!tripId && !activityId && !collectionId) return Response.json({ error: "Choose a trip, an activity or a collection." }, { status: 400 });
  if (activityId && !(await db.activity.findUnique({ where: { id: activityId, trip: { deletingAt: null } }, select: { id: true } }))) return Response.json({ error: "That activity no longer exists." }, { status: 404 });
  if (!activityId && tripId && !(await db.trip.findUnique({ where: { id: tripId, deletingAt: null }, select: { id: true } }))) return Response.json({ error: "That trip no longer exists." }, { status: 404 });
  if (collectionId && !(await db.collection.findUnique({ where: { id: collectionId }, select: { id: true } }))) return Response.json({ error: "That collection no longer exists." }, { status: 404 });

  let filed = 0;
  let notYours = 0;
  for (const photoId of new Set(parsed.data.photoIds)) {
    const r = await fileExisting(viewer.user, photoId, { tripId, activityId, collectionId });
    if (r.notYours) notYours++;
    else if (r.trip || r.activity || r.collection) filed++;
  }
  if (filed) revalidatePath("/", "layout");
  return Response.json({ filed, notYours });
}
