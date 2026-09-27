"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
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
import { removeMemberAs } from "@/lib/auth/remove-member";
import { deleteTripById } from "@/lib/trips/delete";
import { foldDuplicates } from "@/lib/photos/duplicates";
import { emptyQuarantine, quarantineOrphanPhotoFolders, type QuarantineResult } from "@/lib/storage/sweep";
import { rebindInstall } from "@/lib/storage/identity";
import { NAME_CHECKS } from "@/lib/people/name-check";
import { rejudgeFromAction } from "@/lib/annotation/rejudge-notice";

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
  const existing = await db.user.findUnique({ where: { email }, select: { removingAt: true } });
  if (existing?.removingAt) return { status: "error", message: "They are still being removed; try again when that finishes." };
  if (existing) return { status: "error", message: "That person is already a member." };
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
  await db.$transaction(async (tx) => {
    // As removeMember: both accounts locked in one order, the actor still an admin, and never the last admin gone —
    // two admins demoting each other at once demote one.
    const users = await tx.$queryRaw<{ id: string; role: string; removingAt: Date | null }[]>`SELECT id, role::text AS role, "removingAt" FROM "User" WHERE id IN (${admin.id}, ${userId}) ORDER BY id FOR UPDATE`;
    const member = users.find((u) => u.id === userId);
    if (!member) throw new Error("That member is no longer in the album.");
    // Being removed is final: made an admin again, they would count towards an album that is losing them.
    if (member.removingAt) throw new Error("That member is being removed.");
    if (users.find((u) => u.id === admin.id)?.role !== "ADMIN") throw new Error("Your account is no longer an admin's.");
    if (role !== "ADMIN") {
      const [{ admins }] = await tx.$queryRaw<{ admins: number }[]>`SELECT count(*)::int AS admins FROM "User" WHERE role = 'ADMIN' AND "removingAt" IS NULL AND id <> ${userId}`;
      if (!admins) throw new Error("The album needs at least one admin.");
    }
    await tx.user.update({ where: { id: userId }, data: { role } });
  });
  revalidatePath("/admin");
}

/**
 * Keep their uploads and what they made: handed over to the acting admin, a batch at a time, then the account, its
 * sessions, its Google connection, and any sign-in link still outstanding for the address go. See
 * lib/auth/remove-member for the steps, and for how a removal interrupted half-way is finished.
 */
export async function removeMember(userId: string): Promise<void> {
  const admin = await requireAdminOrThrow();
  if (userId === admin.id) throw new Error("You can't remove yourself.");
  await removeMemberAs(admin.id, userId);
  revalidatePath("/admin");
}

/** Carry on deleting a trip the worker has not finished yet (see lib/trips/delete); a big one is queued again. */
export async function finishDeletingTrip(tripId: string): Promise<void> {
  await requireAdminOrThrow();
  if (await db.trip.count({ where: { id: tripId, deletingAt: { not: null } } })) await deleteTripById(tripId);
  revalidatePath("/admin");
}

/**
 * Clear what a Google Photos import reported (the files and albums it skipped or could not read, by name): a name in
 * it may be one the album was asked to forget. The counts stay.
 */
export async function clearTakeoutReport(importId: string): Promise<void> {
  await requireAdminOrThrow();
  await db.takeoutImport.updateMany({ where: { id: importId }, data: { report: Prisma.DbNull } });
  revalidatePath("/admin");
  revalidatePath("/people/forgotten");
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

/**
 * Move the photo folders that have no photo in this album to the quarantine. The admin types how many, so a count
 * that changed since the page was drawn is caught; the limits and the identity check are the library's.
 */
export async function quarantineOrphanFolders(typed: string): Promise<QuarantineResult> {
  await requireAdminOrThrow();
  const expected = Number(typed.trim());
  if (!Number.isInteger(expected) || expected <= 0) return { ok: false, message: "Type the number of folders to move." };
  const result = await quarantineOrphanPhotoFolders(expected);
  revalidatePath("/admin");
  return result;
}

/** Delete what has been in the quarantine for longer than it is kept; anything moved more recently stays. */
export async function emptyOldQuarantine(): Promise<QuarantineResult> {
  await requireAdminOrThrow();
  const result = await emptyQuarantine();
  revalidatePath("/admin");
  return result;
}

/** After a genuine move or restore: make this database the storage folder's owner, if it accounts for what is there. */
export async function rebindStorage(): Promise<{ ok: boolean; message: string }> {
  await requireAdminOrThrow();
  const result = await rebindInstall();
  revalidatePath("/admin");
  return result;
}

/**
 * How names are checked before words are shown to everyone, album-wide (see lib/people/name-check). An admin's
 * decision, recorded with who and when. Made stricter, what is already shown is checked again in the background at
 * once (and by the nightly sweep, should that not run); made relaxed, nothing kept for the family is let out by it:
 * the relaxed check applies to what is judged or shown from then on.
 */
export async function setAlbumNameCheck(fd: FormData): Promise<void> {
  const admin = await requireAdminOrThrow();
  const level = z.enum(NAME_CHECKS).parse(fd.get("nameCheck"));
  const tightened = await db.$transaction(async (tx) => {
    await tx.appSetting.upsert({ where: { id: "app" }, create: { id: "app" }, update: {} });
    // Locked, so two admins changing it at once each see the other's.
    const [before] = await tx.$queryRaw<{ nameCheck: string }[]>`SELECT "nameCheck"::text AS "nameCheck" FROM "AppSetting" WHERE id = 'app' FOR UPDATE`;
    const stricter = before?.nameCheck === "RELAXED" && level === "STRICT";
    const now = new Date();
    await tx.appSetting.update({ where: { id: "app" }, data: { nameCheck: level, nameCheckSetAt: now, nameCheckSetById: admin.id, ...(stricter ? { nameCheckTightenedAt: now } : {}) } });
    return stricter;
  });
  if (tightened) await rejudgeFromAction({ recheck: {} });
  revalidatePath("/admin");
  revalidatePath("/", "layout");
}
