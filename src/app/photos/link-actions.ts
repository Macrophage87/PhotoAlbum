"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canEditMedia, NOT_YOURS } from "@/lib/auth/ownership";
import { orderPair } from "@/lib/photos/relations";

const RELATIONS = ["SAME_SCENE", "BEFORE_AFTER", "PANORAMA_PART", "DETAIL_OF", "RELATED"] as const;

export async function linkPhotos(photoId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  // A link is made from the item whose page you are on; it is that item you must be able to change.
  const owner = await db.photo.findUnique({ where: { id: photoId }, select: { uploaderId: true } });
  if (!owner) return;
  if (!canEditMedia(user, owner)) throw new Error(NOT_YOURS);
  const parsed = z
    .object({ otherId: z.string().min(1), relation: z.enum(RELATIONS), note: z.string().trim().max(200).optional() })
    .safeParse({ otherId: fd.get("otherId"), relation: fd.get("relation") ?? "RELATED", note: fd.get("note") ?? undefined });
  if (!parsed.success || parsed.data.otherId === photoId) return;
  const [a, b] = orderPair(photoId, parsed.data.otherId);
  const both = await db.photo.count({ where: { id: { in: [a, b] } } });
  if (both !== 2) return;
  await db.photoLink.upsert({
    where: { photoAId_photoBId_relation: { photoAId: a, photoBId: b, relation: parsed.data.relation } },
    update: { note: parsed.data.note || null },
    create: { photoAId: a, photoBId: b, relation: parsed.data.relation, note: parsed.data.note || null },
  });
  revalidatePath(`/photos/${a}`);
  revalidatePath(`/photos/${b}`);
}

export async function unlinkPhotos(linkId: string): Promise<void> {
  const user = await requireUserOrThrow();
  const link = await db.photoLink.findUnique({ where: { id: linkId }, include: { photoA: { select: { uploaderId: true } }, photoB: { select: { uploaderId: true } } } });
  if (!link) return;
  // Either end of the link is enough: both pages show it, and undoing it is undoing one thing.
  if (!canEditMedia(user, link.photoA) && !canEditMedia(user, link.photoB)) throw new Error(NOT_YOURS);
  await db.photoLink.delete({ where: { id: linkId } });
  revalidatePath(`/photos/${link.photoAId}`);
  revalidatePath(`/photos/${link.photoBId}`);
}
