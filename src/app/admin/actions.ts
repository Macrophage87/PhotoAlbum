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
import { revokeRemovedConnection } from "@/lib/google/account";
import { forgetJudgedNames } from "@/lib/annotation/rejudge";
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
  await db.$transaction(async (tx) => {
    // As removeMember: both accounts locked in one order, the actor still an admin, and never the last admin gone —
    // two admins demoting each other at once demote one.
    const users = await tx.$queryRaw<{ id: string; role: string }[]>`SELECT id, role::text AS role FROM "User" WHERE id IN (${admin.id}, ${userId}) ORDER BY id FOR UPDATE`;
    if (!users.some((u) => u.id === userId)) throw new Error("That member is no longer in the album.");
    if (users.find((u) => u.id === admin.id)?.role !== "ADMIN") throw new Error("Your account is no longer an admin's.");
    if (role !== "ADMIN") {
      const [{ admins }] = await tx.$queryRaw<{ admins: number }[]>`SELECT count(*)::int AS admins FROM "User" WHERE role = 'ADMIN' AND id <> ${userId}`;
      if (!admins) throw new Error("The album needs at least one admin.");
    }
    await tx.user.update({ where: { id: userId }, data: { role } });
  });
  revalidatePath("/admin");
}

/** A member with tens of thousands of uploads takes seconds to hand over: well past a transaction's default five. */
const REMOVE_MEMBER_TX = { timeout: 120_000, maxWait: 10_000 };

export async function removeMember(userId: string): Promise<void> {
  const admin = await requireAdminOrThrow();
  if (userId === admin.id) throw new Error("You can't remove yourself.");
  // Keep their uploads and what they made: reassign ownership to the acting admin, then delete the account, its
  // sessions, its Google connection, and any sign-in link still outstanding for the address. Every reference to
  // them that would stop the delete is handed over here, or none of it happens.
  const remove = () =>
    db.$transaction(async (tx) => {
      // Both accounts locked, in one order, so two admins removing each other take turns: the second finds itself
      // gone. A member already removed is nothing to do; an acting admin removed or demoted meanwhile may not.
      const users = await tx.$queryRaw<{ id: string; role: string; email: string }[]>`SELECT id, role::text AS role, email FROM "User" WHERE id IN (${admin.id}, ${userId}) ORDER BY id FOR UPDATE`;
      const member = users.find((u) => u.id === userId);
      if (!member) return null;
      if (users.find((u) => u.id === admin.id)?.role !== "ADMIN") throw new Error("Your account is no longer an admin's.");
      // Never the last admin: somebody has to be able to run the album.
      const [{ admins }] = await tx.$queryRaw<{ admins: number }[]>`SELECT count(*)::int AS admins FROM "User" WHERE role = 'ADMIN' AND id <> ${userId}`;
      if (!admins) throw new Error("The album needs at least one admin.");
      // Their uploads and their choices, in one pass over the photographs. Their choices stay choices: left to the
      // foreign keys these setters would be emptied, and an empty setter means the album's own guess — a photo they
      // took off an activity put straight back on it, a place they removed filled in again, a date they fixed re-read.
      await tx.$executeRaw`
        UPDATE "Photo" SET
          "uploaderId" = CASE WHEN "uploaderId" = ${userId} THEN ${admin.id} ELSE "uploaderId" END,
          "activitySetById" = CASE WHEN "activitySetById" = ${userId} THEN ${admin.id} ELSE "activitySetById" END,
          "placeSetById" = CASE WHEN "placeSetById" = ${userId} THEN ${admin.id} ELSE "placeSetById" END,
          "dateSetById" = CASE WHEN "dateSetById" = ${userId} THEN ${admin.id} ELSE "dateSetById" END
        WHERE "uploaderId" = ${userId} OR "activitySetById" = ${userId} OR "placeSetById" = ${userId} OR "dateSetById" = ${userId}`;
      await tx.track.updateMany({ where: { uploaderId: userId }, data: { uploaderId: admin.id } });
      await tx.trip.updateMany({ where: { createdById: userId }, data: { createdById: admin.id } });
      await tx.collection.updateMany({ where: { createdById: userId }, data: { createdById: admin.id } });
      await tx.collectionItem.updateMany({ where: { addedById: userId }, data: { addedById: admin.id } });
      const google = await tx.$queryRaw<{ token: string }[]>`DELETE FROM "GoogleAccount" WHERE "userId" = ${userId} RETURNING "encryptedRefreshToken" AS token`;
      // Their name, recorded as judged, goes with them.
      await forgetJudgedNames(tx, `user:${userId}`);
      await tx.user.delete({ where: { id: userId } });
      await tx.magicLinkToken.deleteMany({ where: { email: member.email } });
      return { token: google[0]?.token ?? null };
    }, REMOVE_MEMBER_TX);
  // A write conflict or deadlock with something else changing their photographs is tried once more.
  const done = await remove().catch((err: unknown) => {
    const e = err as { code?: string; meta?: { code?: string } };
    // Prisma's own code, or Postgres's through a raw statement (deadlock, serialization failure).
    if (e.code === "P2034" || e.meta?.code === "40P01" || e.meta?.code === "40001") return remove();
    throw err;
  });
  // Revoked at Google only once they are gone: a removal that failed leaves them connected as they were. One Google
  // could not be told about is tried again from the queue, carrying only the sealed token.
  if (done && (await revokeRemovedConnection(userId, done.token)) === "failed") {
    await enqueue(QUEUES.revokeGoogle, { encryptedRefreshToken: done.token }, { retryLimit: 10, retryDelay: 600, retryBackoff: true }).catch((err) => {
      console.error("[admin] could not queue the retry of a removed member's Google revocation", err instanceof Error ? err.message : err);
    });
  }
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
