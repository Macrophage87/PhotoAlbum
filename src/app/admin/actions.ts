"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { createInvite } from "@/lib/auth/magic-link";
import { inviteEmail, sendMail } from "@/lib/auth/email";
import { normalizeEmail } from "@/lib/auth/tokens";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { deleteArchive, safeArchivePath } from "@/lib/takeout/inbox";
import { closeDeadImports } from "@/lib/takeout/import";
import { stat } from "node:fs/promises";
import { disconnectGoogleAccount } from "@/lib/google/account";

async function requireAdminOrThrow() {
  const user = await requireUserOrThrow();
  if (user.role !== "ADMIN") throw new Error("Admins only");
  return user;
}

export type InviteState = { status: "idle" } | { status: "sent"; email: string } | { status: "error"; message: string };

export async function inviteMember(_prev: InviteState, fd: FormData): Promise<InviteState> {
  const admin = await requireAdminOrThrow();
  const parsed = z.object({ email: z.string().email(), role: z.enum(["ADMIN", "MEMBER"]) }).safeParse({ email: fd.get("email"), role: fd.get("role") ?? "MEMBER" });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };
  const email = normalizeEmail(parsed.data.email);
  if (await db.user.findUnique({ where: { email } })) return { status: "error", message: "That person is already a member." };
  await db.invite.deleteMany({ where: { email, acceptedAt: null } });
  const { token } = await createInvite(email, admin.id, parsed.data.role, { db });
  const link = new URL(`/invite/${token}`, env().APP_URL).toString();
  await sendMail(inviteEmail(email, link, admin.name ?? admin.email));
  revalidatePath("/admin");
  return { status: "sent", email };
}

export async function revokeInvite(id: string): Promise<void> {
  await requireAdminOrThrow();
  await db.invite.deleteMany({ where: { id, acceptedAt: null } });
  revalidatePath("/admin");
}

export async function setRole(userId: string, role: "ADMIN" | "MEMBER"): Promise<void> {
  const admin = await requireAdminOrThrow();
  if (userId === admin.id) throw new Error("You can't change your own role.");
  await db.user.update({ where: { id: userId }, data: { role } });
  revalidatePath("/admin");
}

export async function removeMember(userId: string): Promise<void> {
  const admin = await requireAdminOrThrow();
  if (userId === admin.id) throw new Error("You can't remove yourself.");
  // Their Google connection goes with them (revoked at Google when possible, deleted here regardless).
  await disconnectGoogleAccount(userId);
  // Keep their uploads: reassign ownership to the acting admin, then delete the account and its sessions.
  await db.$transaction([
    db.photo.updateMany({ where: { uploaderId: userId }, data: { uploaderId: admin.id } }),
    db.track.updateMany({ where: { uploaderId: userId }, data: { uploaderId: admin.id } }),
    db.trip.updateMany({ where: { createdById: userId }, data: { createdById: admin.id } }),
    db.user.delete({ where: { id: userId } }),
  ]);
  revalidatePath("/admin");
}

/** Queue one Takeout archive from the inbox. One import runs at a time so the worker's memory stays bounded. */
export async function startTakeoutImport(archiveName: string): Promise<void> {
  const admin = await requireAdminOrThrow();
  const file = safeArchivePath(archiveName);
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) throw new Error("That archive is no longer in the inbox.");
  await closeDeadImports();
  const running = await db.takeoutImport.count({ where: { status: "RUNNING" } });
  if (running > 0) throw new Error("An import is still running; wait for it to finish.");
  const run = await db.takeoutImport.create({ data: { archiveName, startedById: admin.id } });
  await enqueue(QUEUES.takeoutImport, { importId: run.id }, { expireInSeconds: 12 * 3600, retryLimit: 0 });
  revalidatePath("/admin");
}

/** Remove an archive from the inbox once its photos are in the album (it is an unencrypted copy of the export). */
export async function deleteTakeoutArchive(archiveName: string): Promise<void> {
  await requireAdminOrThrow();
  await deleteArchive(archiveName);
  revalidatePath("/admin");
}
