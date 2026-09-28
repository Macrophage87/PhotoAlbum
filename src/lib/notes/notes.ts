import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { canViewMedia } from "@/lib/auth/access";
import { clientNetwork, forwardedClient } from "@/lib/auth/client-address";
import { mediaAccessInclude, toMediaAccess } from "@/lib/photos/access";
import { dayKey, saltFor } from "@/lib/visits/record";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { checkFormToken, issueFormToken } from "./token";
import { HONEYPOT_FIELD, validateNote, type NoteErrors, type NoteState, type NoteValues } from "./validate";

export type { NoteState } from "./validate";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Notes one sender may send: a few in a sitting, and not many more in a day. */
export const PER_CLIENT = { tenMinutes: 3, day: 10 };
/**
 * Senders no proxy named share one bucket (an install without a proxy is a small one where it is only ever the
 * family and a few friends): looser, as sign-in's is, so one of them cannot use it up for everybody.
 */
export const UNKNOWN_CLIENTS = { tenMinutes: 10, day: 30 };
/** The wider network a sender is in (an IPv6 /48, where one site can hold 65,536 /64s), as sign-in limits it too. */
export const PER_NETWORK = { tenMinutes: 10, day: 30 };
/** Emails to the admins in any 24 hours. Past it notes are still kept, and the notes page says none went out. */
export const MAILED_PER_DAY = 50;
/** How long a note is kept. */
export const KEEP_DAYS = 365;

const RETRY = "Sorry, that didn't go through. Please try sending it again.";
const TOO_MANY_NOW = "You've sent a few notes just now. Please wait ten minutes and try again.";
const TOO_MANY_TODAY = "You've sent a lot of notes today. Please try again tomorrow.";

/**
 * Which sender a note is counted against, as digests: the address the proxy reports (IPv6 by its /64) and the wider
 * network it is in (an IPv6 /48; an IPv4 address is its own), each hashed with the day's visitor salt (VisitSalt),
 * which is thrown away with that day's visits. A row can then say "the same sender as an hour ago" and nothing more,
 * and no address is ever written down. `network` is null when no proxy named the sender.
 */
export async function senderHash(headers: Headers, now: Date): Promise<{ hash: string; network: string | null }> {
  const client = forwardedClient(headers);
  const salt = await saltFor(dayKey(now));
  const digest = (what: string) => createHash("sha256").update(`${salt}\nvisitor-note\n${what}`).digest("hex").slice(0, 32);
  return { hash: digest(client ?? "unknown"), network: client ? digest(`network:${clientNetwork(client)}`) : null };
}

/**
 * The photograph a note is about, only if the sender may see it. A hidden photograph and one that does not exist
 * both come back as nothing, and nothing about the answer the sender gets differs either way.
 */
export async function visiblePhoto(viewer: Viewer, raw: unknown): Promise<{ id: string; imageVersion: number; kind: string } | null> {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return null;
  const photo = await db.photo.findUnique({ where: { id: raw }, select: { id: true, imageVersion: true, kind: true, ...mediaAccessInclude } });
  return photo && canViewMedia(viewer, toMediaAccess(photo)) ? { id: photo.id, imageVersion: photo.imageVersion, kind: photo.kind } : null;
}

/**
 * The album page a note was sent from, as a path on this album and nothing else: another site's address is
 * dropped, and so are the query and a share link's or an invite's token, which is a password. A path that lost its
 * token has "…" in its place (see `isPrivateLinkPath`).
 */
export function notePagePath(raw: unknown, appUrl: string): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw, appUrl);
  } catch {
    return null;
  }
  if (url.origin !== new URL(appUrl).origin) return null;
  const path = url.pathname
    .replace(/^\/share\/(a\/|c\/)?[^/]+/, (_m, kind: string | undefined) => `/share/${kind ?? ""}…`)
    .replace(/^\/invite\/[^/]+/, "/invite/…");
  // "//host" is a path to the URL parser but another site to the link an admin is shown.
  if (path === "/note" || !/^\/(?![\/\\])/.test(path)) return null;
  return path.slice(0, 300);
}

/** A page reached by a private link, whose token was not kept: there is nothing to link an admin back to. */
export function isPrivateLinkPath(path: string): boolean {
  return path.includes("…");
}

function valuesOf(fd: FormData): NoteValues {
  const get = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v.slice(0, 4000) : "";
  };
  return { name: get("name"), email: get("email"), message: get("message"), photo: get("photo"), page: get("page") };
}

export type SubmitContext = { viewer: Viewer; headers: Headers; appUrl: string; now?: Date };

/**
 * Everything the note form's action does, in order: the honeypot (a silent "thank you", and nothing kept), the
 * timing token, the fields, the sender's limits, then the note is kept and the admins' email is queued. The email
 * is the worker's job: however it fares, the sender has already been thanked.
 */
export async function submitNote(fd: FormData, ctx: SubmitContext): Promise<NoteState> {
  const now = ctx.now ?? new Date();
  const values = valuesOf(fd);
  const honey = fd.get(HONEYPOT_FIELD);
  if (typeof honey === "string" && honey.trim()) return { status: "sent" };

  const token = fd.get("token");
  if ((await checkFormToken(token, now.getTime())) !== "ok") {
    return { status: "error", message: RETRY, errors: {}, token: await issueFormToken(now.getTime()), values };
  }
  const again = (message: string | null, errors: NoteErrors = {}): NoteState => ({ status: "error", message, errors, token: token as string, values });

  const checked = validateNote(values);
  if (!checked.ok) return again(null, checked.errors);

  const sender = await senderHash(ctx.headers, now);
  const photoId = (await visiblePhoto(ctx.viewer, values.photo))?.id ?? null;
  const limits = sender.network ? PER_CLIENT : UNKNOWN_CLIENTS;
  const since = (ms: number) => ({ gt: new Date(now.getTime() - ms) });
  // Counted and kept under one lock, so notes sent all at once are counted one after another rather than all
  // against the same empty count.
  const outcome = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('visitor-note'))`;
    const [lately, today, networkLately, networkToday, mailedToday] = await Promise.all([
      tx.visitorNote.count({ where: { clientHash: sender.hash, createdAt: since(10 * MINUTE) } }),
      tx.visitorNote.count({ where: { clientHash: sender.hash, createdAt: since(DAY) } }),
      sender.network ? tx.visitorNote.count({ where: { networkHash: sender.network, createdAt: since(10 * MINUTE) } }) : 0,
      sender.network ? tx.visitorNote.count({ where: { networkHash: sender.network, createdAt: since(DAY) } }) : 0,
      tx.visitorNote.count({ where: { unmailed: false, createdAt: since(DAY) } }),
    ]);
    if (lately >= limits.tenMinutes || networkLately >= PER_NETWORK.tenMinutes) return { refused: TOO_MANY_NOW } as const;
    if (today >= limits.day || networkToday >= PER_NETWORK.day) return { refused: TOO_MANY_TODAY } as const;
    const unmailed = mailedToday >= MAILED_PER_DAY;
    const note = await tx.visitorNote.create({
      data: { ...checked.note, photoId, pageUrl: notePagePath(values.page, ctx.appUrl), clientHash: sender.hash, networkHash: sender.network, unmailed, createdAt: now },
      select: { id: true },
    });
    return { id: note.id, unmailed } as const;
    // A flood waits its turn for the lock rather than failing to start.
  }, { maxWait: 15_000, timeout: 15_000 });
  if ("refused" in outcome) return again(outcome.refused);
  // Only once the note is surely kept: the worker must find it.
  if (!outcome.unmailed) {
    await enqueue(QUEUES.mailVisitorNote, { noteId: outcome.id }).catch((err) => {
      console.error("[notes] could not queue the email about a note; it is on the notes page", err instanceof Error ? err.message : err);
    });
  }
  return { status: "sent" };
}

/** Notes past their year go in the nightly sweep. */
export async function purgeVisitorNotes(now = new Date()): Promise<number> {
  const r = await db.visitorNote.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_DAYS * DAY) } } });
  return r.count;
}
