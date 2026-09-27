import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { canViewActivity, canViewMedia, viewerFor } from "@/lib/auth/access";
import { mediaAccessInclude, mediaTripNameable, toMediaAccess } from "@/lib/photos/access";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { photoUrl } from "@/lib/photos/urls";
import { uploaderLabel } from "@/components/photos/toGrid";
import { MAX_DESCRIBED } from "./view";

/** What a map shows of a photograph once it is clicked: the pin itself carries only where and when. */
export type MapPhotoDetail = {
  id: string;
  thumbUrl: string;
  mediumUrl: string;
  caption: string | null;
  /** Named only where the trip may be named to this viewer, or the viewer holds the activity's own link. */
  activityTitle: string | null;
  /** Members only. */
  uploadedBy: string | null;
  /** Named only where this viewer may open the trip: a private trip's name is the family's, like its photographs. */
  trip: { slug: string; title: string } | null;
};

/**
 * The details of the photographs a map was clicked on, for whoever is asking.
 *
 * Every photograph is checked on its own, by the rule the picture's bytes follow: a member sees anything, anybody
 * else what is in a trip or collection they may open (a public one, or one whose link they hold) or on an activity
 * whose link they hold. Nothing in the trash and nothing still being processed is described to anybody, as neither is
 * on any map. One that may not be described is left out, just as one that does not exist is, so the answer never says
 * which it was. `view=share` answers a member as the share page's visitors are answered: no names.
 */
export async function describeMapPhotos(viewer: Viewer, ids: string[], view: string | null): Promise<MapPhotoDetail[]> {
  if (!ids.length) return [];
  const shown = viewerFor(viewer, view);
  const member = shown.kind === "user";
  const found = await db.photo.findMany({
    where: { id: { in: ids.slice(0, MAX_DESCRIBED) }, ...NOT_TRASHED, status: "READY" },
    select: {
      id: true,
      caption: true,
      updatedAt: true,
      uploader: { select: { name: true, email: true } },
      ...mediaAccessInclude,
      trip: { select: { id: true, slug: true, title: true, visibility: true, shareToken: true } },
      activity: { select: { id: true, title: true, shareToken: true } },
    },
  });
  const byId = new Map(found.map((p) => [p.id, p]));
  const out: MapPhotoDetail[] = [];
  for (const id of new Set(ids)) {
    const p = byId.get(id);
    if (!p || !canViewMedia(viewer, toMediaAccess(p))) continue;
    const tripNamed = mediaTripNameable(shown, p.trip);
    out.push({
      id: p.id,
      thumbUrl: photoUrl(p, "thumb"),
      mediumUrl: photoUrl(p, "medium"),
      caption: p.caption,
      // An activity belongs to its trip; its own link names it too, as the activity's map always has.
      activityTitle: p.activity && (tripNamed || canViewActivity(shown, p.activity)) ? p.activity.title : null,
      uploadedBy: member ? uploaderLabel(p.uploader?.name, p.uploader?.email) : null,
      trip: tripNamed ? { slug: p.trip!.slug, title: p.trip!.title } : null,
    });
  }
  return out;
}
