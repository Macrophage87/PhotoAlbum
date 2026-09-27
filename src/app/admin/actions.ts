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
import { ArchiveDeleteError, deleteArchive, safeArchivePath } from "@/lib/takeout/inbox";
import { closeDeadImports } from "@/lib/takeout/import";
import { stat } from "node:fs/promises";
import { revokeRemovedConnection } from "@/lib/google/account";
import { foldDuplicates } from "@/lib/photos/duplicates";

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
  // Links asked for before the invite were never sent (or were placeholders); clearing them means the invitee's
  // first request is not told a link is already on its way.
  await db.magicLinkToken.deleteMany({ where: { email, usedAt: null } });
  const { token } = await createInvite(email, admin.id, parsed.data.role, { db });
  const link = new URL(`/invite/${token}`, env().APP_URL).toString();
  await sendMail(inviteEmail(email, link, admin.name ?? admin.email));
  revalidatePath("/admin");
  return { status: "sent", email };
}

export async function revokeInvite(id: string): Promise<void> {
  await requireAdminOrThrow();
  const invite = await db.invite.findFirst({ where: { id, acceptedAt: null }, select: { email: true } });
  if (!invite) return;
  // A sign-in link the invitee already asked for goes too; one that is still out there would otherwise make them a member.
  const member = await db.user.findUnique({ where: { email: invite.email }, select: { id: true } });
  await db.$transaction([
    db.invite.deleteMany({ where: { id, acceptedAt: null } }),
    ...(member ? [] : [db.magicLinkToken.deleteMany({ where: { email: invite.email } })]),
  ]);
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
  const member = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!member) return;
  // Keep their uploads and what they made: reassign ownership to the acting admin, then delete the account, its
  // sessions, its Google connection, and any sign-in link still outstanding for the address. Every reference to
  // them that would stop the delete is handed over here, or none of it happens.
  const google = await db.$transaction(async (tx) => {
    const account = await tx.googleAccount.findUnique({ where: { userId }, select: { encryptedRefreshToken: true } });
    await tx.photo.updateMany({ where: { uploaderId: userId }, data: { uploaderId: admin.id } });
    await tx.track.updateMany({ where: { uploaderId: userId }, data: { uploaderId: admin.id } });
    await tx.trip.updateMany({ where: { createdById: userId }, data: { createdById: admin.id } });
    await tx.collection.updateMany({ where: { createdById: userId }, data: { createdById: admin.id } });
    await tx.collectionItem.updateMany({ where: { addedById: userId }, data: { addedById: admin.id } });
    // Their choices stay choices. Left to the foreign keys these would be emptied, and an empty setter means the
    // album's own guess: a photo they took off an activity would be put straight back on it, a place they removed
    // filled in again, a date they fixed re-read from the file.
    await tx.photo.updateMany({ where: { activitySetById: userId }, data: { activitySetById: admin.id } });
    await tx.photo.updateMany({ where: { placeSetById: userId }, data: { placeSetById: admin.id } });
    await tx.photo.updateMany({ where: { dateSetById: userId }, data: { dateSetById: admin.id } });
    await tx.user.delete({ where: { id: userId } });
    await tx.magicLinkToken.deleteMany({ where: { email: member.email } });
    return account;
  });
  // Revoked at Google only once they are gone: a removal that failed leaves them connected as they were.
  await revokeRemovedConnection(userId, google?.encryptedRefreshToken ?? null);
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

/**
 * Remove an archive from the inbox once its photos are in the album (it is an unencrypted copy of the export).
 * Answers with the reason when it could not, so the admin sees it rather than a generic error.
 */
export async function deleteTakeoutArchive(archiveName: string): Promise<string | null> {
  await requireAdminOrThrow();
  await closeDeadImports();
  if (await db.takeoutImport.count({ where: { archiveName, status: "RUNNING" } })) return `${archiveName} is being imported; delete it once the import has finished.`;
  try {
    await deleteArchive(archiveName);
  } catch (err) {
    if (err instanceof ArchiveDeleteError) return err.message;
    throw err;
  }
  revalidatePath("/admin");
  return null;
}

/**
 * Fold every set of byte-identical photographs into one. See lib/photos/duplicates: the oldest finished one is kept,
 * whatever it was missing is taken from its copies, and the copies go to the trash marked as duplicates — so this
 * is reversible until somebody empties the trash.
 */
export async function foldDuplicatePhotos(): Promise<{ groups: number; folded: number; conflicts: string[]; coversReleased: string[] }> {
  const admin = await requireAdminOrThrow();
  const report = await foldDuplicates(admin.id);
  revalidatePath("/admin");
  revalidatePath("/", "layout");
  return { groups: report.groups, folded: report.folded, conflicts: report.conflicts, coversReleased: report.coversReleased };
}
