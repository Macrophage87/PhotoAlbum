"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { appScheme, createPhoneLink, isChallenge } from "@/lib/auth/phone-link";
import { rejudgeFromAction } from "@/lib/annotation/rejudge-notice";

const nameSchema = z.string().trim().max(80).transform((v) => v || null);

/** The name shown next to everything a member uploads; empty falls back to the part of their address before the @. */
export async function updateMyName(fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const name = nameSchema.parse(fd.get("name") ?? "");
  const before = await db.user.findUnique({ where: { id: user.id }, select: { name: true } });
  await db.user.update({ where: { id: user.id }, data: { name } });
  // An uploader's name is members-only too: what the helper wrote before it was known is judged again, and
  // the old one once that was judged (see `namesOfJob`).
  if (name !== before?.name) await rejudgeFromAction({ members: [user.id] });
  revalidatePath("/", "layout");
}

/** Admins can name a member who has not done it themselves, so "uploaded by" reads well for everyone. */
export async function setMemberName(userId: string, fd: FormData): Promise<void> {
  const me = await requireUserOrThrow();
  if (me.role !== "ADMIN") throw new Error("Admins only");
  const name = nameSchema.parse(fd.get("name") ?? "");
  const before = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  await db.user.update({ where: { id: userId }, data: { name } });
  if (name !== before?.name) await rejudgeFromAction({ members: [userId] });
  revalidatePath("/", "layout");
}

/**
 * A signed-in member says the album's app may be connected as them. The answer is a one-time code in the address
 * of the page they land on, which hands it back to the app (see src/lib/auth/phone-link.ts).
 */
export async function connectPhone(fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const challenge = fd.get("challenge");
  if (!isChallenge(challenge)) throw new Error("Open this page from the app");
  const app = appScheme(fd.get("app"));
  const code = await createPhoneLink(db, user.id, challenge, typeof fd.get("name") === "string" ? (fd.get("name") as string) : null);
  redirect(`/account/phone?app=${app}&code=${code}`);
}

/** Sign one phone out. Only ever the member's own: the id names nothing unless it is theirs. */
export async function disconnectPhone(fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const id = fd.get("id");
  if (typeof id === "string") await db.deviceToken.deleteMany({ where: { id, userId: user.id } });
  revalidatePath("/account");
}
