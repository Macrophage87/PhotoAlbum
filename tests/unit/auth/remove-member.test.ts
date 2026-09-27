import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";
import { dbHooks } from "../helpers/hooked-db";

/** Who is acting: the next id in the queue, or the default. */
const who = vi.hoisted(() => ({ id: "", next: [] as string[], queued: [] as { queue: string; data: unknown }[], revoke: "revoked" as "revoked" | "failed" | "none" | "crash", told: [] as string[] }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.next.shift() ?? who.id, email: "a@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (queue: string, data: unknown) => void who.queued.push({ queue, data }) }));
vi.mock("@/lib/db", async () => (await import("../helpers/hooked-db")).hookedDb());
vi.mock("@/lib/google/account", () => ({
  revokeRemovedConnection: async (userId: string, token: string | null) => {
    if (!token) return "none";
    // The process dying right after the account's delete committed, before Google heard anything.
    if (who.revoke === "crash") throw new Error("the process died");
    who.told.push(userId);
    return who.revoke;
  },
}));

import { inviteMember, removeMember, setRole } from "@/app/admin/actions";
import { finishPendingRemovals, INLINE_LIMIT } from "@/lib/auth/remove-member";
import { createInvite, requestMagicLink, verifyMagicLink } from "@/lib/auth/magic-link";
import { revokePendingConnections } from "@/lib/google/pending-revoke";
import { canEditContainer, canEditMedia } from "@/lib/auth/ownership";
import { familyMembers } from "@/lib/people/members";
import { hashToken } from "@/lib/auth/tokens";
import { foldDuplicates } from "@/lib/photos/duplicates";
import { isWriteConflict } from "@/lib/db-conflict";

describe("removing a member", () => {
  let admin: string;
  beforeEach(async () => {
    dbHooks.raw = dbHooks.transaction = null;
    await resetTestDb();
    who.queued = [];
    who.next = [];
    who.revoke = "revoked";
    who.told = [];
    admin = who.id = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const member = (email = "cousin@example.com", role: "MEMBER" | "ADMIN" = "MEMBER") => db.user.create({ data: { email, role, name: "Cousin Pat" } });
  const photos = async (uploaderId: string, n: number, extra: Record<string, unknown> = {}, prefix = uploaderId) => {
    const rows = Array.from({ length: n }, (_, i) => ({ uploaderId, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `${prefix}${i}`, originalPath: `${prefix}${i}/o.jpg`, sizeBytes: 1, status: "READY" as const, ...extra }));
    for (let i = 0; i < n; i += 2000) await db.photo.createMany({ data: rows.slice(i, i + 2000) });
  };
  /** Whatever still names them anywhere on a photograph. */
  const naming = (id: string) => db.photo.count({ where: { OR: [{ uploaderId: id }, { dateSetById: id }, { placeSetById: id }, { activitySetById: id }, { editedById: id }, { trashedById: id }] } });
  /** The worker dying part-way through the hand-over: the `n`th batch never runs, nor anything after it. */
  const dieAtBatch = (n: number) => {
    let calls = 0;
    dbHooks.raw = async () => {
      if (++calls === n) throw new Error("the worker died");
    };
    return { mockRestore: () => void (dbHooks.raw = null) };
  };

  it("hands over tens of thousands of uploads and choices a batch at a time, well past a transaction's default five seconds", async () => {
    const m = await member();
    const N = 12_000;
    const rows = Array.from({ length: N }, (_, i) => ({ uploaderId: i % 2 ? m.id : admin, originalName: `${i}.jpg`, mimeType: "image/jpeg", storageKey: `k${i}`, originalPath: `k${i}/o.jpg`, sizeBytes: 1, status: "READY" as const, ...(i % 3 === 0 ? { dateSetById: m.id, takenAtSource: "MANUAL" as const } : {}), ...(i % 7 === 0 ? { placeSetById: m.id } : {}) }));
    for (let i = 0; i < N; i += 2000) await db.photo.createMany({ data: rows.slice(i, i + 2000) });
    // Far too many for the admin's request: begun there, and left to the worker at once.
    await removeMember(m.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: m.id } })).removingAt).toBeInstanceOf(Date);
    expect(who.queued).toEqual([{ queue: "finish-removals", data: {} }]);
    expect(await db.photo.count({ where: { uploaderId: m.id } })).toBe(N / 2);
    expect(await finishPendingRemovals()).toBe(1);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(await db.photo.count({ where: { uploaderId: admin } })).toBe(N);
    expect(await db.photo.count({ where: { dateSetById: admin } })).toBe(Math.ceil(N / 3));
    expect(await db.photo.count({ where: { placeSetById: admin } })).toBe(Math.ceil(N / 7));
  }, 120_000);

  it("lets two admins removing each other at once remove only one, never the last admin", async () => {
    const other = await member("other@example.com", "ADMIN");
    who.next = [admin, other.id];
    const results = await Promise.allSettled([removeMember(other.id), removeMember(admin)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/no longer an admin/) }) });
    expect(await db.user.count({ where: { role: "ADMIN" } })).toBe(1);
  });

  it("is nothing to do when the member is already gone, twice at once included", async () => {
    const m = await member();
    await Promise.all([removeMember(m.id), removeMember(m.id)]);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    await expect(removeMember(m.id)).resolves.toBeUndefined();
  });

  it("refuses an acting admin who was demoted meanwhile", async () => {
    const m = await member();
    await db.user.update({ where: { id: admin }, data: { role: "MEMBER" } });
    await expect(removeMember(m.id)).rejects.toThrow(/no longer an admin/);
    expect(await db.user.count({ where: { id: m.id } })).toBe(1);
  });

  it("never lets two admins demoting each other at once leave no admin, and refuses a demoted or removed actor", async () => {
    const other = await member("other@example.com", "ADMIN");
    who.next = [admin, other.id];
    const results = await Promise.allSettled([setRole(other.id, "MEMBER"), setRole(admin, "MEMBER")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.user.count({ where: { role: "ADMIN" } })).toBe(1);
    // The one left is refused once demoted in turn by somebody else's hand, as is a removed one.
    const m = await member();
    const actor = (await db.user.findFirstOrThrow({ where: { role: "ADMIN" } })).id;
    await db.user.update({ where: { id: actor }, data: { role: "MEMBER" } });
    who.next = [actor];
    await expect(setRole(m.id, "ADMIN")).rejects.toThrow(/no longer an admin/);
    expect((await db.user.findUniqueOrThrow({ where: { id: m.id } })).role).toBe("MEMBER");
  });

  it("takes their judged name with them, and keeps the revocation until Google can be told", async () => {
    const m = await member();
    await db.appSetting.create({ data: { id: "app", membersOnlyNames: [`user:${m.id}:Cousin Pat`, `user:${admin}:Dana`] } });
    await db.googleAccount.create({ data: { userId: m.id, encryptedRefreshToken: "sealed" } });
    who.revoke = "failed";
    await removeMember(m.id);
    expect((await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).membersOnlyNames).toEqual([`user:${admin}:Dana`]);
    expect(await db.googleAccount.count()).toBe(0);
    expect(await db.pendingRevoke.findMany({ select: { userId: true, encryptedRefreshToken: true, attempts: true } })).toEqual([{ userId: m.id, encryptedRefreshToken: "sealed", attempts: 1 }]);
    // The worker's pass tries again, and stops once Google has heard.
    who.revoke = "revoked";
    expect(await revokePendingConnections()).toBe(1);
    expect(await db.pendingRevoke.count()).toBe(0);
    expect(who.told).toEqual([m.id, m.id]);
  });

  it("never loses the revocation to a crash between the account's delete and telling Google", async () => {
    const m = await member();
    await db.googleAccount.create({ data: { userId: m.id, encryptedRefreshToken: "sealed" } });
    who.revoke = "crash";
    await expect(removeMember(m.id)).rejects.toThrow("the process died");
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(await db.pendingRevoke.count()).toBe(1);
    who.revoke = "revoked";
    expect(await revokePendingConnections()).toBe(1);
    expect(who.told).toEqual([m.id]);
    expect(await db.pendingRevoke.count()).toBe(0);
  });

  it("finishes a removal interrupted half-way from its mark, and tells Google only once they are gone", async () => {
    const m = await member();
    await db.session.create({ data: { id: "their-session", userId: m.id, expiresAt: new Date(Date.now() + 86_400_000) } });
    await db.googleAccount.create({ data: { userId: m.id, encryptedRefreshToken: "sealed" } });
    await photos(m.id, 450, { dateSetById: m.id, takenAtSource: "MANUAL" });
    const spy = dieAtBatch(3);
    await expect(removeMember(m.id)).rejects.toThrow("the worker died");
    spy.mockRestore();

    // Decided and under way: signed out, no longer anybody's admin, half handed over, still connected to Google.
    const half = await db.user.findUniqueOrThrow({ where: { id: m.id } });
    expect(half).toMatchObject({ role: "MEMBER", removingById: admin });
    expect(half.removingAt).toBeInstanceOf(Date);
    expect(await db.session.count({ where: { userId: m.id } })).toBe(0);
    const handed = await db.photo.count({ where: { uploaderId: admin, dateSetById: admin } });
    expect(handed).toBeGreaterThan(0);
    expect(await db.photo.count({ where: { uploaderId: m.id, dateSetById: m.id } })).toBe(450 - handed);
    expect(handed).toBeLessThan(450);
    // Their Google connection is parked, not yet revoked: nothing queued for them uses it any more.
    expect(await db.googleAccount.findMany({ select: { needsReconnect: true } })).toEqual([{ needsReconnect: true }]);
    expect(who.told).toEqual([]);
    // Meanwhile they cannot sign in again, nor be made an admin again.
    await db.magicLinkToken.create({ data: { email: m.email, tokenHash: hashToken("their-link"), expiresAt: new Date(Date.now() + 600_000) } });
    await expect(verifyMagicLink("their-link", { db })).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(setRole(m.id, "ADMIN")).rejects.toThrow(/being removed/);

    // The worker's quarter-hourly pass carries on from there.
    expect(await finishPendingRemovals()).toBe(1);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(await db.photo.count({ where: { uploaderId: admin, dateSetById: admin } })).toBe(450);
    expect(await db.googleAccount.count()).toBe(0);
    expect(who.told).toEqual([m.id]);
    // Nothing is left to do, and nothing is done twice.
    expect(await finishPendingRemovals()).toBe(0);
    expect(who.told).toEqual([m.id]);
  }, 60_000);

  it("carries on an interrupted removal as it was begun when another admin presses Remove again", async () => {
    const m = await member();
    const other = await member("other@example.com", "ADMIN");
    await photos(m.id, 300);
    const spy = dieAtBatch(2);
    await expect(removeMember(m.id)).rejects.toThrow("the worker died");
    spy.mockRestore();
    who.next = [other.id];
    await removeMember(m.id);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    // To the admin who began it, not to whoever finished it.
    expect(await db.photo.count({ where: { uploaderId: admin } })).toBe(300);
  }, 60_000);

  it("finishes handing over to an admin before that admin is removed in turn", async () => {
    const m = await member();
    const other = await member("other@example.com", "ADMIN");
    await photos(m.id, 300);
    const spy = dieAtBatch(2);
    await expect(removeMember(m.id)).rejects.toThrow("the worker died");
    spy.mockRestore();
    // The admin taking over is removed by another before the worker got to it: what they were given goes on to them.
    who.next = [other.id];
    await removeMember(admin);
    expect(await db.user.count({ where: { id: { in: [m.id, admin] } } })).toBe(0);
    expect(await db.photo.count({ where: { uploaderId: other.id } })).toBe(300);
  }, 60_000);

  it("hands over what the member saved while their removal ran, and refuses whatever comes after", async () => {
    const m = await member();
    await photos(m.id, 400);
    await photos(admin, 3, {}, "mine");
    const theirs = await db.photo.findFirstOrThrow({ where: { uploaderId: admin } });
    // Once the batches are done, saves of theirs still in flight land: a new upload, and a date on somebody else's.
    let calls = 0;
    dbHooks.transaction = async () => {
      if (++calls !== 2) return;
      dbHooks.transaction = null;
      await photos(m.id, 1, {}, "late");
      await db.photo.update({ where: { id: theirs.id }, data: { dateSetById: m.id, takenAtSource: "MANUAL" } });
    };
    await removeMember(m.id);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(await db.photo.count({ where: { uploaderId: admin } })).toBe(404);
    expect((await db.photo.findUniqueOrThrow({ where: { id: theirs.id } })).dateSetById).toBe(admin);
    await expect(photos(m.id, 1, {}, "later")).rejects.toThrow();
  }, 60_000);

  it("leaves nothing naming a member whose saves keep arriving while they are removed", async () => {
    const m = await member();
    await photos(m.id, 300);
    await photos(admin, 40, {}, "mine");
    const others = (await db.photo.findMany({ where: { uploaderId: admin }, select: { id: true } })).map((p) => p.id);
    let running = true;
    const landed = { uploads: 0, dates: [] as string[] };
    const saves = (async () => {
      for (let i = 0; running; i++) {
        await db.photo.create({ data: { uploaderId: m.id, originalName: `s${i}.jpg`, mimeType: "image/jpeg", storageKey: `s${i}`, originalPath: `s${i}/o.jpg`, sizeBytes: 1, status: "READY" } }).then(() => landed.uploads++, () => undefined);
        const id = others[i % others.length];
        await db.photo.update({ where: { id }, data: { dateSetById: m.id } }).then(() => landed.dates.push(id), () => undefined);
      }
    })();
    await removeMember(m.id);
    running = false;
    await saves;
    // Had the saves pushed them past what the request finishes, the worker would have: it finds nothing left then.
    await finishPendingRemovals();
    expect(landed.uploads).toBeGreaterThan(0);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(await naming(m.id)).toBe(0);
    // Every upload that landed is the admin's, and every date they set is still set, by the admin.
    expect(await db.photo.count({ where: { uploaderId: admin } })).toBe(300 + 40 + landed.uploads);
    expect(await db.photo.count({ where: { id: { in: landed.dates }, dateSetById: null } })).toBe(0);
  }, 60_000);

  it("leaves nothing naming them when a fold runs at the same time, and the fold finishes on its next run", async () => {
    const m = await member();
    // Copies of the same file, the member's and the admin's, each carrying a choice of the member's.
    for (let g = 0; g < 30; g++) {
      for (const [i, uploaderId] of [m.id, admin, m.id].entries()) {
        await db.photo.create({ data: { uploaderId, originalName: `${g}-${i}.jpg`, mimeType: "image/jpeg", storageKey: `d${g}-${i}`, originalPath: `d${g}-${i}/o.jpg`, sizeBytes: 1, status: "READY", contentHash: `bytes-${g}`, createdAt: new Date(2020, 0, 1 + i), ...(i === 2 ? { dateSetById: m.id, takenAt: new Date("2019-08-12"), takenAtSource: "MANUAL" as const } : {}) } });
      }
    }
    await photos(m.id, 380);
    const [fold] = await Promise.all([foldDuplicates(admin), removeMember(m.id)]);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(await naming(m.id)).toBe(0);
    // A group that lost a deadlock with the removal is folded next time; none is left half-folded.
    const again = await foldDuplicates(admin);
    expect(fold.groups + again.groups).toBe(30);
    expect(await db.photo.count({ where: { trashedAt: null, contentHash: { startsWith: "bytes-" } } })).toBe(30);
    // Their dates survived on the keepers, as the admin's.
    expect(await db.photo.count({ where: { trashedAt: null, contentHash: { startsWith: "bytes-" }, dateSetById: admin } })).toBe(30);
  }, 60_000);

  it("tries the last step again when it loses a deadlock to somebody writing their photographs", async () => {
    const m = await member();
    await photos(m.id, 30);
    let calls = 0;
    dbHooks.transaction = async () => {
      // The removal's own first step, then its last, which Postgres picks as the deadlock's victim once.
      if (++calls === 2) throw Object.assign(new Error("deadlock detected"), { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "40P01" } } } });
    };
    await removeMember(m.id);
    expect(calls).toBe(3);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(await db.photo.count({ where: { uploaderId: admin } })).toBe(30);
  });

  it("recognises a deadlock however the driver reports it", () => {
    expect(isWriteConflict({ code: "P2034" })).toBe(true);
    expect(isWriteConflict({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "40P01" } } } })).toBe(true);
    expect(isWriteConflict({ code: "P2010", meta: { code: "40001" } })).toBe(true);
    expect(isWriteConflict({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "23503" } } } })).toBe(false);
    expect(isWriteConflict(new Error("boom"))).toBe(false);
  });

  it("finishes a small removal inside the request, and queues nothing", async () => {
    const m = await member();
    await photos(m.id, INLINE_LIMIT);
    await removeMember(m.id);
    expect(await db.user.count({ where: { id: m.id } })).toBe(0);
    expect(who.queued).toEqual([]);
  });

  it("lets nobody join on the invitation of an admin being removed, one sent as the removal began included", async () => {
    const inviter = await member("inviter@example.com", "ADMIN");
    const { token: inviteToken } = await createInvite("alt@example.com", inviter.id, "ADMIN", { db });
    await photos(inviter.id, 300);
    const spy = dieAtBatch(2);
    await expect(removeMember(inviter.id)).rejects.toThrow("the worker died");
    spy.mockRestore();
    // Their pending invitation went with the mark.
    expect(await db.invite.count({ where: { invitedById: inviter.id } })).toBe(0);
    expect(inviteToken).toBeTruthy();
    // One they sent in the very moment the removal began, which the mark could not see.
    await createInvite("late@example.com", inviter.id, "ADMIN", { db });
    for (const email of ["alt@example.com", "late@example.com"]) {
      expect(await requestMagicLink(email, { db })).toMatchObject({ ok: false, reason: "not_invited" });
      await db.magicLinkToken.create({ data: { email, tokenHash: hashToken(`link-${email}`), expiresAt: new Date(Date.now() + 600_000) } });
      await expect(verifyMagicLink(`link-${email}`, { db })).resolves.toEqual({ ok: false, reason: "invalid" });
    }
    expect(await finishPendingRemovals()).toBe(1);
    expect(await db.user.findMany({ where: { email: { in: ["alt@example.com", "late@example.com", "inviter@example.com"] } } })).toEqual([]);
    expect(await db.user.count({ where: { role: "ADMIN" } })).toBe(1);
  }, 60_000);

  it("sends no sign-in link to a member being removed, and asks for patience when they are invited meanwhile", async () => {
    const m = await member();
    await photos(m.id, 300);
    const spy = dieAtBatch(2);
    await expect(removeMember(m.id)).rejects.toThrow("the worker died");
    spy.mockRestore();
    expect(await requestMagicLink(m.email, { db })).toMatchObject({ ok: false, reason: "not_invited" });
    const fd = new FormData();
    fd.set("email", m.email);
    await expect(inviteMember({ status: "idle" }, fd)).resolves.toEqual({ status: "error", message: "They are still being removed; try again when that finishes." });
    // Nor are they offered anywhere as somebody to file things to, and they may change nothing they could before.
    expect((await familyMembers()).map((f) => f.id)).not.toContain(m.id);
    const being = await db.user.findUniqueOrThrow({ where: { id: m.id } });
    expect(canEditMedia(being, { uploaderId: m.id })).toBe(false);
    expect(canEditContainer({ ...being, role: "ADMIN" }, { createdById: null })).toBe(false);
    expect(canEditMedia({ ...being, removingAt: null }, { uploaderId: m.id })).toBe(true);
  }, 60_000);
});
