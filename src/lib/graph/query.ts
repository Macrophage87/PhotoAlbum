import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { canViewCollection, canViewTrip, visibleMediaWhere } from "@/lib/auth/access";
import { photoUrl } from "@/lib/photos/urls";
import { uploaderLabel } from "@/components/photos/toGrid";
import { edgesWithin } from "./edges";

/** Whole-library graphs are capped; beyond this the scoped views are the way in. */
export const MAX_NODES = 3000;

export type GraphScope = { kind: "all" } | { kind: "trip"; slug: string } | { kind: "collection"; slug: string } | { kind: "person"; id: string };

export type GraphNode = { id: string; thumb: string; medium: string; alt: string; caption: string | null; tripId: string | null; tripTitle: string | null; collectionIds: string[]; personIds: string[]; uploader: string; takenAt: string | null; kind: string };
export type GraphPayload = { nodes: GraphNode[]; edges: { a: string; b: string; score: number }[]; capped: boolean; legend: { trips: { id: string; title: string }[]; collections: { id: string; title: string }[]; people: { id: string; name: string }[] } };

export function parseScope(sp: URLSearchParams): GraphScope {
  const trip = sp.get("trip");
  const collection = sp.get("collection");
  const person = sp.get("person");
  if (trip) return { kind: "trip", slug: trip };
  if (collection) return { kind: "collection", slug: collection };
  if (person) return { kind: "person", id: person };
  return { kind: "all" };
}

/**
 * Nodes are the viewable items in scope with an embedding; edges only those whose both endpoints are nodes.
 * Returns null when the viewer may not see the scoping container (or is not an admin for the whole library).
 */
export async function graphPayload(viewer: Viewer, scope: GraphScope, minScore: number): Promise<GraphPayload | null> {
  if (viewer.kind !== "user") return null;
  let scopeWhere: Record<string, unknown> = {};
  if (scope.kind === "all") {
    if (viewer.user.role !== "ADMIN") return null;
  } else if (scope.kind === "trip") {
    const trip = await db.trip.findUnique({ where: { slug: scope.slug }, select: { id: true, visibility: true, shareToken: true } });
    if (!trip || !canViewTrip(viewer, trip)) return null;
    scopeWhere = { tripId: trip.id };
  } else if (scope.kind === "collection") {
    const c = await db.collection.findUnique({ where: { slug: scope.slug }, select: { id: true, visibility: true, shareToken: true } });
    if (!c || !canViewCollection(viewer, c)) return null;
    scopeWhere = { collections: { some: { collectionId: c.id } } };
  } else {
    const p = await db.person.findUnique({ where: { id: scope.id }, select: { id: true } });
    if (!p) return null;
    scopeWhere = { faces: { some: { personId: p.id, status: "CONFIRMED" } } };
  }
  // embeddedAt is written together with the image embedding, so it stands in for the vector column Prisma cannot filter on.
  const photos = await db.photo.findMany({
    where: { ...visibleMediaWhere(viewer), ...scopeWhere, embeddedAt: { not: null }, status: "READY" },
    orderBy: { createdAt: "desc" },
    take: MAX_NODES + 1,
    select: { id: true, updatedAt: true, caption: true, title: true, originalName: true, kind: true, takenAt: true, tripId: true, trip: { select: { title: true } }, uploader: { select: { name: true, email: true } }, collections: { select: { collectionId: true } }, faces: { where: { status: "CONFIRMED", personId: { not: null } }, select: { personId: true } } },
  });
  const capped = photos.length > MAX_NODES;
  const kept = capped ? photos.slice(0, MAX_NODES) : photos;
  const visible = new Set(kept.map((p) => p.id));
  const ids = [...visible];
  const raw = ids.length ? await db.mediaSimilarity.findMany({ where: { photoAId: { in: ids }, photoBId: { in: ids }, score: { gte: minScore } }, select: { photoAId: true, photoBId: true, score: true } }) : [];
  const edges = edgesWithin(raw.map((e) => ({ a: e.photoAId, b: e.photoBId, score: e.score })), visible, minScore);
  const tripIds = new Set(kept.map((p) => p.tripId).filter(Boolean) as string[]);
  const collectionIds = new Set(kept.flatMap((p) => p.collections.map((c) => c.collectionId)));
  const personIds = new Set(kept.flatMap((p) => p.faces.map((f) => f.personId!)));
  const [trips, collections, people] = await Promise.all([
    db.trip.findMany({ where: { id: { in: [...tripIds] } }, select: { id: true, title: true }, orderBy: { startDate: "desc" } }),
    db.collection.findMany({ where: { id: { in: [...collectionIds] } }, select: { id: true, title: true }, orderBy: { title: "asc" } }),
    db.person.findMany({ where: { id: { in: [...personIds] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    nodes: kept.map((p) => ({ id: p.id, thumb: photoUrl(p, "thumb"), medium: photoUrl(p, "medium"), alt: p.caption ?? p.title ?? p.originalName, caption: p.caption ?? p.title, tripId: p.tripId, tripTitle: p.trip?.title ?? null, collectionIds: p.collections.map((c) => c.collectionId), personIds: [...new Set(p.faces.map((f) => f.personId!))], uploader: uploaderLabel(p.uploader?.name, p.uploader?.email), takenAt: p.takenAt?.toISOString() ?? null, kind: p.kind })),
    edges,
    capped,
    legend: { trips, collections, people },
  };
}

/** The "similar photos" strip: neighbours of one item the viewer may see, best first. */
export async function similarTo(viewer: Viewer, photoId: string, limit = 12) {
  const pairs = await db.mediaSimilarity.findMany({ where: { OR: [{ photoAId: photoId }, { photoBId: photoId }] }, orderBy: { score: "desc" }, take: limit * 2, select: { photoAId: true, photoBId: true, score: true } });
  const otherIds = pairs.map((p) => (p.photoAId === photoId ? p.photoBId : p.photoAId));
  if (!otherIds.length) return [];
  const { photoCardSelect } = await import("@/lib/photos/queries");
  const photos = await db.photo.findMany({ where: { ...visibleMediaWhere(viewer), id: { in: otherIds }, status: "READY" }, select: photoCardSelect });
  const score = new Map(pairs.map((p) => [p.photoAId === photoId ? p.photoBId : p.photoAId, p.score]));
  return photos.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)).slice(0, limit).map((p) => ({ photo: p, score: score.get(p.id) ?? 0 }));
}
