import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sendMail, type Mail } from "@/lib/auth/email";
import { NAME_MAX, oneLine } from "./validate";

type NoteForMail = { name: string; email: string | null; message: string; photoId: string | null; pageUrl: string | null };

/**
 * The email one admin gets about a note: plain text only, with the sender's words as they wrote them. Their name is
 * made one line again before it goes into the subject, whatever the form let through, so it cannot add a header;
 * their address, when they gave one, is where a reply goes.
 */
export function noteEmail(to: string, note: NoteForMail, appUrl: string): Mail {
  const name = oneLine(note.name).slice(0, NAME_MAX) || "a visitor";
  const replyTo = note.email ? oneLine(note.email) : null;
  const lines = [
    `${name} sent the family a note:`,
    "",
    note.message,
    "",
    `From: ${name}`,
    replyTo ? `Email: ${replyTo} (reply to this message to answer them)` : "They didn't leave an email address.",
    ...(note.photoId ? [`About this photo: ${new URL(`/photos/${note.photoId}`, appUrl)}`] : []),
    ...(note.pageUrl ? [note.pageUrl.startsWith("/share/") ? "Sent from a shared link." : `Sent from: ${new URL(note.pageUrl, appUrl)}`] : []),
    "",
    `Every note is on the Admin page: ${new URL("/admin/notes", appUrl)}`,
  ];
  return { to, subject: `A note from ${name} on the family album`, text: lines.join("\n"), ...(replyTo ? { replyTo } : {}) };
}

/**
 * Tell every admin about one note. One admin's mail failing does not stop the others'; only when nobody could be
 * reached does the job fail, and so get retried, which then sends nobody a second copy.
 */
export async function mailVisitorNote(noteId: string): Promise<{ sent: number; failed: number }> {
  const note = await db.visitorNote.findUnique({ where: { id: noteId } });
  if (!note || note.unmailed) return { sent: 0, failed: 0 };
  const admins = await db.user.findMany({ where: { role: "ADMIN", removingAt: null }, select: { email: true } });
  let sent = 0;
  let failed = 0;
  for (const admin of admins) {
    try {
      await sendMail(noteEmail(admin.email, note, env().APP_URL));
      sent++;
    } catch (err) {
      failed++;
      console.error("[notes] could not email an admin about a note", err instanceof Error ? err.message : err);
    }
  }
  if (failed && !sent) throw new Error("No admin could be emailed about a visitor's note");
  return { sent, failed };
}
