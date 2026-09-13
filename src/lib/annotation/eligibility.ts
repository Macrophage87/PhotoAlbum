import { db } from "@/lib/db";
import { env } from "@/lib/env";

export type AnnotationGates = { envEnabled: boolean; hasKey: boolean; optedInAt: Date | null; optedInBy: string | null; active: boolean; model: string };

/** Both gates must hold before anything is sent: the operator's flag and key, and an admin's opt-in on the disclosure screen. */
export async function annotationGates(): Promise<AnnotationGates> {
  const e = env();
  const setting = await db.appSetting.findUnique({ where: { id: "app" }, select: { annotationOptInAt: true, annotationOptInById: true } });
  const envEnabled = e.ANNOTATION_ENABLED;
  const hasKey = Boolean(e.ANTHROPIC_API_KEY);
  const optedInAt = setting?.annotationOptInAt ?? null;
  return { envEnabled, hasKey, optedInAt, optedInBy: setting?.annotationOptInById ?? null, active: envEnabled && hasKey && Boolean(optedInAt), model: e.ANNOTATION_MODEL };
}

/**
 * Prisma filter: items not opted out directly or by inheritance from their trip or any collection holding them.
 *
 * A 3D scan is never sent: what the helper would be shown is a still the album drew of a shape, not a photograph of
 * anything, and describing that is worth nothing to anybody.
 */
export const notOptedOutWhere = {
  kind: { not: "SCAN" as const },
  annotationOptOut: false,
  OR: [{ tripId: null }, { trip: { annotationOptOut: false } }],
  collections: { none: { collection: { annotationOptOut: true } } },
} as const;

/** Why an item will not be sent, or null when it may be. */
export async function optOutReason(photoId: string): Promise<string | null> {
  const p = await db.photo.findUnique({ where: { id: photoId }, select: { kind: true, annotationOptOut: true, trip: { select: { title: true, annotationOptOut: true } }, collections: { select: { collection: { select: { title: true, annotationOptOut: true } } } } } });
  if (!p) return "missing";
  if (p.kind === "SCAN") return "a 3D scan is never sent to the helper";
  if (p.annotationOptOut) return "this item is opted out";
  if (p.trip?.annotationOptOut) return `the trip ${p.trip.title} is opted out`;
  const col = p.collections.find((c) => c.collection.annotationOptOut);
  if (col) return `the collection ${col.collection.title} is opted out`;
  return null;
}
