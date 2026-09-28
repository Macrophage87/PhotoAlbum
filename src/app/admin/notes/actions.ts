"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminOrThrow } from "@/lib/auth/viewer";

const noteId = z.string().min(1).max(64);

/** Visitors' notes are for admins alone: every action asks again, whatever the page showed. */
export async function markNoteRead(id: string): Promise<void> {
  await requireAdminOrThrow();
  await db.visitorNote.updateMany({ where: { id: noteId.parse(id), readAt: null }, data: { readAt: new Date() } });
  revalidatePath("/admin", "layout");
}

export async function deleteNote(id: string): Promise<void> {
  await requireAdminOrThrow();
  await db.visitorNote.deleteMany({ where: { id: noteId.parse(id) } });
  revalidatePath("/admin", "layout");
}
