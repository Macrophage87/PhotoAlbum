import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";
import type { Viewer } from "@/lib/auth/viewer";

const jobs = vi.hoisted(() => ({ queued: [] as { queue: string; data: unknown }[], fail: false }));
vi.mock("@/lib/jobs/boss", () => ({
  enqueue: async (queue: string, data: unknown) => {
    if (jobs.fail) throw new Error("the queue is down");
    jobs.queued.push({ queue, data });
  },
}));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string; html?: string; replyTo?: string }[], failFor: new Set<string>() }));
vi.mock("@/lib/auth/email", () => ({
  sendMail: async (m: { to: string; subject: string; text: string; replyTo?: string }) => {
    if (mail.failFor.has(m.to)) throw new Error("SMTP is down");
    mail.sent.push(m);
  },
}));
// The real viewer (and so the real requireAdminOrThrow), over a session and cookies the test chooses.
const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string | null; role: "ADMIN" | "MEMBER" } }));
vi.mock("@/lib/auth/session", () => ({ readSessionUser: async () => session.user }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { formKey, readFormToken, signFormToken, MAX_FILL_MS } from "@/lib/notes/token";
import { linkCount, onlyLinks, validateNote } from "@/lib/notes/validate";
import { MAILED_PER_DAY, notePagePath, purgeVisitorNotes, submitNote, visiblePhoto } from "@/lib/notes/notes";
import { mailVisitorNote, noteEmail } from "@/lib/notes/mail";
import { deleteNote, markNoteRead } from "@/app/admin/notes/actions";

const APP = "https://album.example";
const T0 = new Date("2026-06-15T12:00:00Z");
const anonymous: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
const from = (ip: string | null) => new Headers(ip ? { "x-forwarded-for": ip } : {});

/** A form as a person sends it: the token was drawn `age` before `now`. */
async function form(fields: Record<string, string>, now: Date, age = 10_000): Promise<FormData> {
  const fd = new FormData();
  fd.set("token", signFormToken(await formKey(), now.getTime() - age));
  fd.set("name", "Aunt Ruth");
  fd.set("message", "Mom's pictures of the lighthouse are wonderful!");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function send(fields: Record<string, string> = {}, opts: { now?: Date; ip?: string | null; viewer?: Viewer; age?: number } = {}) {
  const now = opts.now ?? T0;
  return submitNote(await form(fields, now, opts.age), { viewer: opts.viewer ?? anonymous, headers: from(opts.ip === undefined ? "198.51.100.7" : opts.ip), appUrl: APP, now });
}

const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

beforeEach(async () => {
  await resetTestDb();
  jobs.queued = [];
  jobs.fail = false;
  mail.sent = [];
  mail.failFor = new Set();
  session.user = null;
});

describe("what a note may say", () => {
  it("wants a name and a message, each within its length, and an email only if one is given", () => {
    expect(validateNote({ name: "Ruth", email: "", message: "Hello!" })).toEqual({ ok: true, note: { name: "Ruth", email: null, message: "Hello!" } });
    expect(validateNote({ name: " ", email: "", message: "Hello" })).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    expect(validateNote({ name: "R".repeat(81), email: "", message: "Hello" })).toMatchObject({ ok: false, errors: { name: expect.stringMatching(/80/) } });
    expect(validateNote({ name: "R".repeat(80), email: "", message: "Hello" }).ok).toBe(true);
    expect(validateNote({ name: "Ruth", email: "not an address", message: "Hello" })).toMatchObject({ ok: false, errors: { email: expect.any(String) } });
    expect(validateNote({ name: "Ruth", email: " ruth@example.com ", message: "Hello" })).toMatchObject({ ok: true, note: { email: "ruth@example.com" } });
    expect(validateNote({ name: "Ruth", email: "", message: "" })).toMatchObject({ ok: false, errors: { message: expect.any(String) } });
    expect(validateNote({ name: "Ruth", email: "", message: "x".repeat(2001) })).toMatchObject({ ok: false, errors: { message: expect.stringMatching(/2,000/) } });
    expect(validateNote({ name: "Ruth", email: "", message: "x".repeat(2000) }).ok).toBe(true);
    expect(validateNote({ name: undefined, email: null, message: 42 }).ok).toBe(false);
  });

  it("makes a name one line, so it cannot carry a header into the email's subject", () => {
    const r = validateNote({ name: "Ruth\r\nBcc: everyone@example.com", email: "", message: "Hi" });
    expect(r).toEqual({ ok: true, note: { name: "Ruth Bcc: everyone@example.com", email: null, message: "Hi" } });
  });

  it("takes two links, not three, and never nothing but links", () => {
    expect(linkCount("see https://a.example/x and www.b.example")).toBe(2);
    expect(validateNote({ name: "R", email: "", message: "Look: https://a.example and https://b.example" }).ok).toBe(true);
    expect(validateNote({ name: "R", email: "", message: "https://a.example https://b.example https://c.example great photos" })).toMatchObject({ ok: false, errors: { message: expect.stringMatching(/no more than 2 links/) } });
    expect(onlyLinks("https://spam.example")).toBe(true);
    expect(onlyLinks("  www.spam.example , https://x.example! ")).toBe(true);
    expect(onlyLinks("Lovely! https://x.example")).toBe(false);
    expect(validateNote({ name: "R", email: "", message: "https://spam.example" })).toMatchObject({ ok: false, errors: { message: expect.stringMatching(/not just a link/) } });
  });
});

describe("the timing token", () => {
  it("is good from three seconds after the form was drawn until a day after", async () => {
    const key = await formKey();
    const t = T0.getTime();
    expect(readFormToken(key, signFormToken(key, t - 10_000), t)).toBe("ok");
    expect(readFormToken(key, signFormToken(key, t - 1_000), t)).toBe("too-fast");
    expect(readFormToken(key, signFormToken(key, t - MAX_FILL_MS - 1), t)).toBe("stale");
    // Drawn in the future, missing, or not ours: all simply stale.
    expect(readFormToken(key, signFormToken(key, t + 60_000), t)).toBe("stale");
    expect(readFormToken(key, undefined, t)).toBe("stale");
    expect(readFormToken(key, "", t)).toBe("stale");
    const good = signFormToken(key, t - 10_000);
    const [issued, sig] = good.split(".") as [string, string];
    expect(readFormToken(key, `${Number(issued) - 60_000}.${sig}`, t)).toBe("stale");
    expect(readFormToken(key, `${issued}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, t)).toBe("stale");
    expect(readFormToken(Buffer.alloc(32, 1), good, t)).toBe("stale");
  });

  it("sends a form back with a fresh token and what was typed when it came too fast, too late, or with no token", async () => {
    for (const age of [500, MAX_FILL_MS + 1]) {
      const r = await send({ message: "Hi there" }, { age });
      expect(r).toMatchObject({ status: "error", message: expect.stringMatching(/try sending it again/), values: { name: "Aunt Ruth", message: "Hi there" } });
      if (r.status !== "error") throw new Error();
      expect(readFormToken(await formKey(), r.token, T0.getTime() + 5_000)).toBe("ok");
    }
    const fd = await form({}, T0);
    fd.delete("token");
    expect(await submitNote(fd, { viewer: anonymous, headers: from("198.51.100.7"), appUrl: APP, now: T0 })).toMatchObject({ status: "error", message: expect.stringMatching(/try sending it again/) });
    expect(await db.visitorNote.count()).toBe(0);
    expect(jobs.queued).toEqual([]);
  });
});

describe("the honeypot", () => {
  it("thanks whoever filled it in, and keeps nothing", async () => {
    expect(await send({ website: "https://spam.example" })).toEqual({ status: "sent" });
    // Before anything else is looked at: a script that also posted at once, with no token, is thanked the same way.
    const fd = new FormData();
    fd.set("website", "x");
    expect(await submitNote(fd, { viewer: anonymous, headers: from(null), appUrl: APP, now: T0 })).toEqual({ status: "sent" });
    expect(await db.visitorNote.count()).toBe(0);
    expect(jobs.queued).toEqual([]);
  });
});

describe("sending a note", () => {
  it("keeps it with a hash of the sender, never their address, and queues the admins' email", async () => {
    expect(await send({ email: "ruth@example.com" })).toEqual({ status: "sent" });
    const [note] = await db.visitorNote.findMany();
    expect(note).toMatchObject({ name: "Aunt Ruth", email: "ruth@example.com", message: "Mom's pictures of the lighthouse are wonderful!", photoId: null, readAt: null, unmailed: false });
    expect(note!.clientHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(note)).not.toContain("198.51.100.7");
    expect(jobs.queued).toEqual([{ queue: "mail-visitor-note", data: { noteId: note!.id } }]);
  });

  it("says each problem beside its field and keeps what was typed", async () => {
    const r = await send({ name: "", email: "nope" });
    expect(r).toMatchObject({ status: "error", message: null, errors: { name: expect.any(String), email: expect.any(String) }, values: { email: "nope" } });
    expect(await db.visitorNote.count()).toBe(0);
  });

  it("still thanks the sender when the email cannot even be queued", async () => {
    jobs.fail = true;
    expect(await send()).toEqual({ status: "sent" });
    expect(await db.visitorNote.count()).toBe(1);
  });

  it("keeps where it was sent from as a path on this album, without a share link's token", () => {
    expect(notePagePath("https://album.example/trips/acadia/photos?x=1#y", APP)).toBe("/trips/acadia/photos");
    expect(notePagePath("https://album.example/share/SECRETtoken/photos", APP)).toBe("/share/…/photos");
    expect(notePagePath("https://album.example/share/c/SECRETtoken", APP)).toBe("/share/c/…");
    expect(notePagePath("https://album.example/share/a/SECRETtoken", APP)).toBe("/share/a/…");
    expect(notePagePath("https://elsewhere.example/trips/acadia", APP)).toBe(null);
    expect(notePagePath("https://album.example/note", APP)).toBe(null);
    expect(notePagePath("https://album.example//evil.example/x", APP)).toBe(null);
    expect(notePagePath("https://album.example/\\evil.example", APP)).toBe(null);
    expect(notePagePath(null, APP)).toBe(null);
  });
});

describe("limits", () => {
  it("takes three notes from one sender in ten minutes, and more from somebody else", async () => {
    for (const m of [0, 1, 2]) expect(await send({}, { now: minutes(m) })).toEqual({ status: "sent" });
    expect(await send({}, { now: minutes(3) })).toMatchObject({ status: "error", message: expect.stringMatching(/wait ten minutes/) });
    expect(await send({}, { now: minutes(3), ip: "203.0.113.9" })).toEqual({ status: "sent" });
    // An IPv6 sender is counted by its /64, which it can move around in freely.
    for (const [m, ip] of [[4, "2001:db8:1:2::1"], [5, "2001:db8:1:2::2"], [6, "2001:db8:1:2::3"]] as const) expect(await send({}, { now: minutes(m), ip })).toEqual({ status: "sent" });
    expect(await send({}, { now: minutes(7), ip: "2001:db8:1:2:ffff::9" })).toMatchObject({ status: "error" });
    // Ten minutes on, the first sender may write again.
    expect(await send({}, { now: minutes(11) })).toEqual({ status: "sent" });
    expect(await db.visitorNote.count()).toBe(8);
  });

  it("takes ten from one sender in a day", async () => {
    for (let i = 0; i < 10; i++) expect(await send({}, { now: minutes(i * 11) })).toEqual({ status: "sent" });
    expect(await send({}, { now: minutes(10 * 11) })).toMatchObject({ status: "error", message: expect.stringMatching(/tomorrow/) });
    expect(await db.visitorNote.count()).toBe(10);
  });

  it("lets senders no proxy named share a looser bucket", async () => {
    for (let i = 0; i < 10; i++) expect(await send({}, { now: minutes(i / 10), ip: null })).toEqual({ status: "sent" });
    expect(await send({}, { now: minutes(1), ip: null })).toMatchObject({ status: "error" });
  });

  it("past the day's cap keeps notes but emails nobody about them", async () => {
    const hour = 60 * 60 * 1000;
    await db.visitorNote.createMany({ data: Array.from({ length: MAILED_PER_DAY - 1 }, (_, i) => ({ name: "N", message: "m", clientHash: `other${i}`, createdAt: new Date(T0.getTime() - hour) })) });
    // Yesterday's do not count.
    await db.visitorNote.create({ data: { name: "Old", message: "m", clientHash: "old", createdAt: new Date(T0.getTime() - 25 * hour) } });
    expect(await send()).toEqual({ status: "sent" });
    expect(jobs.queued).toHaveLength(1);
    expect(await send({}, { ip: "203.0.113.9" })).toEqual({ status: "sent" });
    expect(jobs.queued).toHaveLength(1);
    expect(await db.visitorNote.count({ where: { unmailed: true } })).toBe(1);
    expect(await db.visitorNote.count()).toBe(MAILED_PER_DAY + 2);
  });
});

describe("the photograph a note is about", () => {
  let publicPhoto = "";
  let privatePhoto = "";
  let linkPhoto = "";
  let linkTrip = "";

  beforeEach(async () => {
    const owner = await db.user.create({ data: { email: "owner@example.com", role: "ADMIN" } });
    const trip = (slug: string, visibility: "PUBLIC" | "PRIVATE" | "LINK") =>
      db.trip.create({ data: { slug, title: slug, visibility, shareToken: visibility === "LINK" ? "tok-123" : null, startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: owner.id } });
    const photo = (tripId: string) => db.photo.create({ data: { uploaderId: owner.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", tripId } });
    publicPhoto = (await photo((await trip("acadia", "PUBLIC")).id)).id;
    privatePhoto = (await photo((await trip("secret", "PRIVATE")).id)).id;
    linkTrip = (await trip("linked", "LINK")).id;
    linkPhoto = (await photo(linkTrip)).id;
  });

  it("is recorded only when the sender can see it", async () => {
    expect(await send({ photo: publicPhoto })).toEqual({ status: "sent" });
    expect((await db.visitorNote.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).photoId).toBe(publicPhoto);
    // A share link's cookie shows its trip's photographs, and so lets them be written about.
    const holder: Viewer = { kind: "anonymous", user: null, shareTokens: new Map([[`trip_${linkTrip}`, "tok-123"]]) };
    expect(await send({ photo: linkPhoto }, { viewer: holder, now: minutes(1) })).toEqual({ status: "sent" });
    expect((await db.visitorNote.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).photoId).toBe(linkPhoto);
  });

  it("treats a hidden photograph exactly like one that does not exist, and like none at all", async () => {
    const answers = [];
    for (const [i, photo] of [privatePhoto, linkPhoto, "no-such-photo", ""].entries()) answers.push(await send({ photo }, { now: minutes(i * 11) }));
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify({ status: "sent" })]));
    expect((await db.visitorNote.findMany()).map((n) => n.photoId)).toEqual([null, null, null, null]);
    expect(await visiblePhoto(anonymous, privatePhoto)).toBe(null);
    expect(await visiblePhoto(anonymous, "no-such-photo")).toBe(null);
    expect(await visiblePhoto(anonymous, publicPhoto)).toMatchObject({ id: publicPhoto });
  });

  it("is not recorded once the photograph goes in the trash, and the note outlives the photograph", async () => {
    await db.photo.update({ where: { id: publicPhoto }, data: { trashedAt: new Date() } });
    await send({ photo: publicPhoto });
    expect((await db.visitorNote.findFirstOrThrow()).photoId).toBe(null);
    await db.photo.update({ where: { id: publicPhoto }, data: { trashedAt: null } });
    await send({ photo: publicPhoto }, { now: minutes(1) });
    await db.photo.delete({ where: { id: publicPhoto } });
    expect(await db.visitorNote.count()).toBe(2);
  });
});

describe("the admins' email", () => {
  beforeEach(async () => {
    await db.user.createMany({ data: [
      { email: "mom@example.com", role: "ADMIN" },
      { email: "dad@example.com", role: "ADMIN" },
      { email: "cousin@example.com", role: "MEMBER" },
    ] });
  });

  it("goes to every admin, and nobody else, with the sender's address to reply to", async () => {
    const photo = await db.photo.create({ data: { uploaderId: (await db.user.findFirstOrThrow({ where: { email: "mom@example.com" } })).id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } });
    const note = await db.visitorNote.create({ data: { name: "Aunt Ruth", email: "ruth@example.com", message: "Lovely.\nTruly.", photoId: photo.id, pageUrl: "/trips/acadia", clientHash: "h" } });
    expect(await mailVisitorNote(note.id)).toEqual({ sent: 2, failed: 0 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["dad@example.com", "mom@example.com"]);
    for (const m of mail.sent) {
      expect(m).toMatchObject({ subject: "A note from Aunt Ruth on the family album", replyTo: "ruth@example.com" });
      expect(m.html).toBeUndefined();
      expect(m.text).toContain("Lovely.\nTruly.");
      expect(m.text).toMatch(new RegExp(`^About this photo: https?://\\S+/photos/${photo.id}$`, "m"));
    }
  });

  it("has no Reply-To when the sender gave no address, and a one-line subject whatever the name holds", async () => {
    const m = noteEmail("mom@example.com", { name: "Eve\r\nBcc: all@example.com\n", email: null, message: "Hi", photoId: null, pageUrl: "/share/…" }, APP);
    expect(m.subject).toBe("A note from Eve Bcc: all@example.com on the family album");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.replyTo).toBeUndefined();
    expect(m.text).toContain("Sent from a shared link.");
    expect(m.text).not.toContain("/share/");
  });

  it("reaches the admins it can when one address fails, and is retried only when none could be reached", async () => {
    const note = await db.visitorNote.create({ data: { name: "Ruth", message: "Hi", clientHash: "h" } });
    mail.failFor = new Set(["dad@example.com"]);
    expect(await mailVisitorNote(note.id)).toEqual({ sent: 1, failed: 1 });
    mail.failFor = new Set(["dad@example.com", "mom@example.com"]);
    await expect(mailVisitorNote(note.id)).rejects.toThrow(/No admin/);
    // Either way the note is there for the admins to read.
    expect(await db.visitorNote.count()).toBe(1);
  });

  it("is not sent about a note past the day's cap, or one deleted meanwhile", async () => {
    const quiet = await db.visitorNote.create({ data: { name: "Ruth", message: "Hi", clientHash: "h", unmailed: true } });
    expect(await mailVisitorNote(quiet.id)).toEqual({ sent: 0, failed: 0 });
    expect(await mailVisitorNote("gone")).toEqual({ sent: 0, failed: 0 });
    expect(mail.sent).toEqual([]);
  });
});

describe("the admins' inbox", () => {
  it("marks read and deletes for an admin only", async () => {
    const note = await db.visitorNote.create({ data: { name: "Ruth", message: "Hi", clientHash: "h" } });
    const member = await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    const admin = await db.user.create({ data: { email: "mom@example.com", role: "ADMIN" } });

    session.user = null;
    await expect(markNoteRead(note.id)).rejects.toThrow("Unauthorized");
    await expect(deleteNote(note.id)).rejects.toThrow("Unauthorized");
    session.user = { id: member.id, email: member.email, name: null, role: "MEMBER" };
    await expect(markNoteRead(note.id)).rejects.toThrow("Admins only");
    await expect(deleteNote(note.id)).rejects.toThrow("Admins only");
    expect(await db.visitorNote.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ readAt: null });

    session.user = { id: admin.id, email: admin.email, name: null, role: "ADMIN" };
    await markNoteRead(note.id);
    expect((await db.visitorNote.findUniqueOrThrow({ where: { id: note.id } })).readAt).toBeInstanceOf(Date);
    await deleteNote(note.id);
    expect(await db.visitorNote.count()).toBe(0);
  });
});

describe("the nightly sweep", () => {
  it("deletes notes older than a year and keeps the rest", async () => {
    const day = 24 * 60 * 60 * 1000;
    await db.visitorNote.createMany({ data: [
      { name: "Old", message: "m", clientHash: "h", createdAt: new Date(T0.getTime() - 366 * day) },
      { name: "Recent", message: "m", clientHash: "h", createdAt: new Date(T0.getTime() - 364 * day) },
    ] });
    expect(await purgeVisitorNotes(T0)).toBe(1);
    expect((await db.visitorNote.findMany()).map((n) => n.name)).toEqual(["Recent"]);
  });
});
