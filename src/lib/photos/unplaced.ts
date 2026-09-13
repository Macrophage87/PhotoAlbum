import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { isAdmin } from "@/lib/auth/ownership";
import type { ViewerUser } from "@/lib/auth/viewer";
import { photoUrl } from "@/lib/photos/urls";

/**
 * The photographs waiting to be put on the map.
 *
 * Two kinds are worth offering: the ones with no position at all — a scan, a phone that stripped its GPS, anything
 * sent through a chat app — and the ones the helper only guessed at, which a person can correct to the actual spot.
 * A member is offered their own; an admin, everyone's, since somebody has to be able to finish the job.
 */

export const TRAY_PAGE = 60;

export type TrayPhoto = { id: string; thumbUrl: string; label: string; takenAt: string | null; tripTitle: string | null; guess: string | null; lat: number | null; lng: number | null };

export async function unplacedForTray(user: ViewerUser, opts: { tripId?: string | null; cursor?: string | null; take?: number } = {}): Promise<{ photos: TrayPhoto[]; nextCursor: string | null; total: number }> {
  const take = opts.take ?? TRAY_PAGE;
  const where: Prisma.PhotoWhereInput = {
    ...NOT_TRASHED,
    status: "READY",
    kind: { in: ["PHOTO", "VIDEO"] },
    ...(opts.tripId ? { tripId: opts.tripId } : {}),
    ...(isAdmin(user) ? {} : { uploaderId: user.id }),
    // No position at all, or one the helper guessed at and nobody has agreed to.
    OR: [{ lat: null }, { gpsSource: "ESTIMATE" }],
  };
  const [rows, total] = await Promise.all([
    db.photo.findMany({
      where,
      orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: { id: true, updatedAt: true, caption: true, title: true, originalName: true, takenAt: true, lat: true, lng: true, placeEstimateName: true, trip: { select: { title: true } } },
    }),
    db.photo.count({ where }),
  ]);
  const more = rows.length > take;
  const page = more ? rows.slice(0, take) : rows;
  return {
    photos: page.map((p) => ({
      id: p.id,
      thumbUrl: photoUrl(p, "thumb"),
      label: p.caption ?? p.title ?? p.originalName,
      takenAt: p.takenAt?.toISOString() ?? null,
      tripTitle: p.trip?.title ?? null,
      guess: p.lat !== null ? p.placeEstimateName ?? "somewhere guessed" : null,
      lat: p.lat,
      lng: p.lng,
    })),
    nextCursor: more ? page[page.length - 1].id : null,
    total,
  };
}
