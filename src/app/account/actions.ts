"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { rejudgeFromAction } from "@/lib/annotation/rejudge-notice";

const nameSchema = z.string().trim().max(80).transform((v) => v || null);

/** The name shown next to everything a member uploads; empty falls back to the part of their address before the @. */
export async function updateMyName(fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const name = nameSchema.parse(fd.get("name") ?? "");
  const before = await db.user.findUnique({ where: { id: user.id }, select: { name: true } });
  await db.user.update({ where: { id: user.id }, data: { name } });
  // An uploader's name is members-only too: what the helper wrote before it was known is judged again.
  if (name && name !== before?.name) await rejudgeFromAction({ names: [name] });
  revalidatePath("/", "layout");
}

/** Admins can name a member who has not done it themselves, so "uploaded by" reads well for everyone. */
export async function setMemberName(userId: string, fd: FormData): Promise<void> {
  const me = await requireUserOrThrow();
  if (me.role !== "ADMIN") throw new Error("Admins only");
  const name = nameSchema.parse(fd.get("name") ?? "");
  const before = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  await db.user.update({ where: { id: userId }, data: { name } });
  if (name && name !== before?.name) await rejudgeFromAction({ names: [name] });
  revalidatePath("/", "layout");
}
