import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export const photoCardSelect = {
  id: true,
  tripId: true,
  activityId: true,
  status: true,
  width: true,
  height: true,
  takenAt: true,
  tzOffsetMin: true,
  lat: true,
  lng: true,
  gpsSource: true,
  caption: true,
  originalName: true,
  updatedAt: true,
  uploader: { select: { name: true } },
} satisfies Prisma.PhotoSelect;

export type PhotoCard = Prisma.PhotoGetPayload<{ select: typeof photoCardSelect }>;

export async function listTripPhotos(tripId: string, uploaderId?: string): Promise<PhotoCard[]> {
  return db.photo.findMany({
    where: { tripId, ...(uploaderId ? { uploaderId } : {}), status: { in: ["READY", "PENDING", "PROCESSING", "FAILED"] } },
    orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    select: photoCardSelect,
  });
}

export async function listUnassignedPhotos(): Promise<PhotoCard[]> {
  return db.photo.findMany({
    where: { tripId: null },
    orderBy: [{ createdAt: "desc" }],
    select: photoCardSelect,
  });
}
