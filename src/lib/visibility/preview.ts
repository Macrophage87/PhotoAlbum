import { db } from "@/lib/db";
import { summarizeExposure, type Change, type ContainerRef, type ExposureSummary, type ItemContainers } from "./exposure";

const include = {
  trip: { select: { id: true, slug: true, title: true, visibility: true } },
  collections: { select: { collection: { select: { id: true, slug: true, title: true, visibility: true } } } },
} as const;

type Row = { id: string; trip: { id: string; slug: string; title: string; visibility: "PRIVATE" | "LINK" | "PUBLIC" } | null; collections: { collection: { id: string; slug: string; title: string; visibility: "PRIVATE" | "LINK" | "PUBLIC" } }[] };

function toItem(row: Row): ItemContainers {
  return {
    id: row.id,
    trip: row.trip ? { kind: "trip", ...row.trip } : null,
    collections: row.collections.map((c) => ({ kind: "collection", ...c.collection })),
  };
}

/** Items with their containers, by photo id. */
export async function itemsById(photoIds: string[]): Promise<ItemContainers[]> {
  const rows = await db.photo.findMany({ where: { id: { in: photoIds } }, select: { id: true, ...include } });
  return rows.map(toItem);
}

/** Every item held by one container. */
export async function itemsOfContainer(kind: "trip" | "collection", id: string): Promise<ItemContainers[]> {
  const rows = await db.photo.findMany({ where: kind === "trip" ? { tripId: id } : { collections: { some: { collectionId: id } } }, select: { id: true, ...include } });
  return rows.map(toItem);
}

export async function containerRef(kind: "trip" | "collection", id: string): Promise<ContainerRef | null> {
  const row = kind === "trip" ? await db.trip.findUnique({ where: { id }, select: { id: true, slug: true, title: true, visibility: true } }) : await db.collection.findUnique({ where: { id }, select: { id: true, slug: true, title: true, visibility: true } });
  return row ? { kind, ...row } : null;
}

export async function previewChange(items: ItemContainers[], change: Change): Promise<ExposureSummary> {
  return summarizeExposure(items, change);
}
