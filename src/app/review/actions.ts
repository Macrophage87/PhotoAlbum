"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";

const ids = z.array(z.string().min(1)).min(1).max(500);
const text = z.string().max(4000);

/** Set (or append to) the free-text context of many items at once; `contextUpdatedAt` drives re-annotation later. */
export async function setContext(photoIds: string[], value: string, mode: "replace" | "append"): Promise<number> {
  await requireUserOrThrow();
  const list = ids.parse(photoIds);
  const note = text.parse(value).trim();
  const now = new Date();
  if (mode === "replace") {
    const res = await db.photo.updateMany({ where: { id: { in: list } }, data: { context: note || null, contextUpdatedAt: now } });
    revalidatePath("/", "layout");
    return res.count;
  }
  const rows = await db.photo.findMany({ where: { id: { in: list } }, select: { id: true, context: true } });
  await db.$transaction(rows.map((r) => db.photo.update({ where: { id: r.id }, data: { context: [r.context?.trim(), note].filter(Boolean).join("\n") || null, contextUpdatedAt: now } })));
  revalidatePath("/", "layout");
  return rows.length;
}

/** Mark a batch reviewed. Annotation (a later phase) hangs off this moment rather than off upload. */
export async function markReviewed(photoIds: string[]): Promise<number> {
  await requireUserOrThrow();
  const list = ids.parse(photoIds);
  const res = await db.photo.updateMany({ where: { id: { in: list }, reviewedAt: null }, data: { reviewedAt: new Date() } });
  revalidatePath("/review");
  return res.count;
}
