"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { editableMediaIds } from "@/lib/auth/ownership";
import { enqueueAnnotation } from "@/lib/jobs/handlers/annotation-sweep";
import { enqueueMatch } from "@/lib/jobs/handlers/match-photo";

const ids = z.array(z.string().min(1)).min(1).max(500);
const text = z.string().max(4000);

/** How many of a selection were changed, and how many were somebody else's and so left alone. */
export type ReviewResult = { n: number; notYours: number };

/**
 * Set (or append to) the free-text context of many items at once; `contextUpdatedAt` drives re-annotation later.
 * The notes are the uploader's account of a photograph, so only their own items (anyone's, for an admin) are touched.
 */
export async function setContext(photoIds: string[], value: string, mode: "replace" | "append"): Promise<ReviewResult> {
  const user = await requireUserOrThrow();
  const asked = ids.parse(photoIds);
  const note = text.parse(value).trim();
  const list = await editableMediaIds(user, asked);
  const notYours = asked.length - list.length;
  if (!list.length) return { n: 0, notYours };
  const now = new Date();
  if (mode === "replace") {
    const res = await db.photo.updateMany({ where: { id: { in: list } }, data: { context: note || null, contextUpdatedAt: now, annotationError: null } });
    await enqueueMatch(list);
    revalidatePath("/", "layout");
    return { n: res.count, notYours };
  }
  const rows = await db.photo.findMany({ where: { id: { in: list } }, select: { id: true, context: true } });
  await db.$transaction(rows.map((r) => db.photo.update({ where: { id: r.id }, data: { context: [r.context?.trim(), note].filter(Boolean).join("\n") || null, contextUpdatedAt: now, annotationError: null } })));
  await enqueueMatch(list);
  revalidatePath("/", "layout");
  return { n: rows.length, notYours };
}

/**
 * Mark a batch reviewed. Annotation (a later phase) hangs off this moment rather than off upload, so it is the
 * uploader's moment too: somebody else's items keep waiting for them, or for the quiet period.
 */
export async function markReviewed(photoIds: string[]): Promise<ReviewResult> {
  const user = await requireUserOrThrow();
  const asked = ids.parse(photoIds);
  const list = await editableMediaIds(user, asked);
  const notYours = asked.length - list.length;
  if (!list.length) return { n: 0, notYours };
  const res = await db.photo.updateMany({ where: { id: { in: list }, reviewedAt: null }, data: { reviewedAt: new Date() } });
  await enqueueAnnotation(list);
  revalidatePath("/review");
  return { n: res.count, notYours };
}
