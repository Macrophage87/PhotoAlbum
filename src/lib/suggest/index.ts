import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { localDayFromOffset } from "@/lib/time/local-day";
import { dateColumnToDay } from "@/lib/time/local-day";
import { suggest, type Candidate, type Item, type Suggestion } from "./score";

/** Load every trip and collection as a scoring candidate. Centroids come from the stored image embeddings. */
export async function loadCandidates(): Promise<Candidate[]> {
  const [trips, collections, centroids] = await Promise.all([
    db.trip.findMany({ select: { id: true, title: true, startDate: true, endDate: true, timezone: true, photos: { where: { lat: { not: null }, lng: { not: null } }, select: { lat: true, lng: true }, take: 200 }, activities: { where: { track: { isNot: null } }, select: { title: true, track: { select: { minLat: true, maxLat: true, minLng: true, maxLng: true } } } } } }),
    db.collection.findMany({ select: { id: true, title: true, description: true, _count: { select: { items: true } }, items: { select: { photo: { select: { annotation: true } } }, take: 200 } } }),
    db.$queryRaw<{ collectionId: string; centroid: string | null }[]>`
      SELECT ci."collectionId", avg(p."embedding")::text AS centroid
      FROM "CollectionItem" ci JOIN "Photo" p ON p.id = ci."photoId"
      WHERE p."embedding" IS NOT NULL GROUP BY ci."collectionId"`.catch(() => [] as { collectionId: string; centroid: string | null }[]),
  ]);
  const centroidById = new Map(centroids.map((c) => [c.collectionId, c.centroid ? (JSON.parse(c.centroid) as number[]) : null]));
  return [
    ...trips.map<Candidate>((t) => ({
      kind: "trip",
      id: t.id,
      title: t.title,
      startDay: dateColumnToDay(t.startDate),
      endDay: dateColumnToDay(t.endDate),
      timezone: t.timezone,
      points: t.photos.map((p) => ({ lat: p.lat!, lng: p.lng! })),
      landmarks: t.activities.filter((a) => a.track).map((a) => ({ title: a.title, lat: (a.track!.minLat + a.track!.maxLat) / 2, lng: (a.track!.minLng + a.track!.maxLng) / 2 })),
    })),
    ...collections.map<Candidate>((c) => ({
      kind: "collection",
      id: c.id,
      title: c.title,
      description: c.description,
      tags: new Set(c.items.flatMap((i) => ((i.photo.annotation as StoredAnnotation | null)?.tags ?? []))),
      peopleIds: new Set<string>(),
      centroid: centroidById.get(c.id) ?? null,
      itemCount: c._count.items,
    })),
  ];
}

export async function loadItem(photoId: string): Promise<Item | null> {
  const [p, vec] = await Promise.all([
    db.photo.findUnique({ where: { id: photoId }, select: { id: true, takenAt: true, tzOffsetMin: true, lat: true, lng: true, caption: true, context: true, title: true, annotation: true, tripId: true, collections: { select: { collectionId: true } } } }),
    db.$queryRaw<{ embedding: string | null }[]>`SELECT "embedding"::text AS embedding FROM "Photo" WHERE id = ${photoId}`.catch(() => [] as { embedding: string | null }[]),
  ]);
  if (!p) return null;
  const a = p.annotation as StoredAnnotation | null;
  return {
    id: p.id,
    day: p.takenAt ? localDayFromOffset(p.takenAt, p.tzOffsetMin ?? 0) : null,
    lat: p.lat,
    lng: p.lng,
    tags: new Set(a?.tags ?? []),
    text: [p.title, p.caption, p.context, a?.caption, a?.searchSummary].filter(Boolean).join(" "),
    peopleIds: new Set<string>(),
    embedding: vec[0]?.embedding ? (JSON.parse(vec[0].embedding) as number[]) : null,
    tripId: p.tripId,
    collectionIds: new Set(p.collections.map((c) => c.collectionId)),
  };
}

/** Top suggestions for many items at once (the review screen). */
export async function suggestionsFor(photoIds: string[]): Promise<Record<string, Suggestion[]>> {
  const candidates = await loadCandidates();
  const out: Record<string, Suggestion[]> = {};
  for (const id of photoIds) {
    const item = await loadItem(id);
    if (item) out[id] = suggest(item, candidates);
  }
  return out;
}
