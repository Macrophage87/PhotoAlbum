import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkMagicLink, createInvite, maskEmail, MAX_OUTSTANDING_LINKS, purgeExpiredMagicLinks, requestMagicLink, verifyMagicLink, withdrawMagicLink } from "@/lib/auth/magic-link";
import type { Db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const T0 = new Date("2026-01-01T12:00:00Z");
const deps = (now = T0, adminEmail?: string) => ({ db, adminEmail, now: () => now });

describe("magic link", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("bootstraps the first user as admin", async () => {
    const req = await requestMagicLink("First@Example.com", deps());
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const res = await verifyMagicLink(req.token, deps());
    expect(res).toMatchObject({ ok: true, isNewUser: true, email: "first@example.com" });
    const user = await db.user.findUniqueOrThrow({ where: { email: "first@example.com" } });
    expect(user.role).toBe("ADMIN");
  });

  it("only ADMIN_EMAIL may bootstrap on an empty database when it is configured", async () => {
    const req = await requestMagicLink("stranger@example.com", deps(T0, "owner@example.com"));
    expect(req).toEqual({ ok: false, reason: "not_invited" });
    const owner = await requestMagicLink("Owner@Example.com", deps(T0, "owner@example.com"));
    expect(owner.ok).toBe(true);
  });

  it("rejects uninvited addresses once a user exists", async () => {
    await db.user.create({ data: { email: "owner@example.com", role: "ADMIN" } });
    const req = await requestMagicLink("stranger@example.com", deps());
    expect(req).toEqual({ ok: false, reason: "not_invited" });
  });

  it("allows ADMIN_EMAIL while there are members but no admin yet", async () => {
    await db.user.create({ data: { email: "owner@example.com", role: "MEMBER" } });
    const req = await requestMagicLink("boss@example.com", deps(T0, "boss@example.com"));
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const res = await verifyMagicLink(req.token, deps(T0, "boss@example.com"));
    expect(res.ok).toBe(true);
    const user = await db.user.findUniqueOrThrow({ where: { email: "boss@example.com" } });
    expect(user.role).toBe("ADMIN");
  });

  it("does not recreate ADMIN_EMAIL's account once an admin exists (a removal sticks)", async () => {
    const boss = deps(T0, "boss@example.com");
    const first = await requestMagicLink("boss@example.com", boss);
    if (!first.ok) throw new Error();
    expect((await verifyMagicLink(first.token, boss)).ok).toBe(true);
    // Another admin removes the bootstrap account; a link asked for before the removal is still out there.
    await db.user.create({ data: { email: "other-admin@example.com", role: "ADMIN" } });
    const outstanding = await requestMagicLink("boss@example.com", boss);
    if (!outstanding.ok) throw new Error();
    await db.user.delete({ where: { email: "boss@example.com" } });
    expect(await requestMagicLink("boss@example.com", boss)).toEqual({ ok: false, reason: "not_invited" });
    expect(await verifyMagicLink(outstanding.token, boss)).toEqual({ ok: false, reason: "invalid" });
    expect(await db.user.findUnique({ where: { email: "boss@example.com" } })).toBeNull();
  });

  it("does not give a removed member an account back from a link they already had", async () => {
    await db.user.create({ data: { email: "owner@example.com", role: "ADMIN" } });
    await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    const req = await requestMagicLink("cousin@example.com", deps());
    if (!req.ok) throw new Error();
    await db.user.delete({ where: { email: "cousin@example.com" } });
    expect(await verifyMagicLink(req.token, deps())).toEqual({ ok: false, reason: "invalid" });
    expect(await db.user.findUnique({ where: { email: "cousin@example.com" } })).toBeNull();
  });

  it("does not make a member of somebody whose invite was revoked after they asked for a link", async () => {
    const admin = await db.user.create({ data: { email: "owner@example.com", role: "ADMIN" } });
    await createInvite("cousin@example.com", admin.id, "MEMBER", deps());
    const req = await requestMagicLink("cousin@example.com", deps());
    if (!req.ok) throw new Error();
    await db.invite.deleteMany({ where: { email: "cousin@example.com" } });
    expect(await verifyMagicLink(req.token, deps())).toEqual({ ok: false, reason: "invalid" });
    expect(await db.user.count({ where: { email: "cousin@example.com" } })).toBe(0);
  });

  it("does not create the account when the invite is revoked while the link is being used", async () => {
    const admin = await db.user.create({ data: { email: "owner@example.com", role: "ADMIN" } });
    await createInvite("cousin@example.com", admin.id, "MEMBER", deps());
    const req = await requestMagicLink("cousin@example.com", deps());
    if (!req.ok) throw new Error();
    // The admin's revoke lands just after verify has looked the invite up.
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop !== "invite") return Reflect.get(target, prop);
        return new Proxy(db.invite, {
          get(inv, name) {
            if (name !== "findFirst") return Reflect.get(inv, name);
            return async (args: Parameters<typeof db.invite.findFirst>[0]) => {
              const found = await db.invite.findFirst(args);
              await db.invite.deleteMany({ where: { email: "cousin@example.com" } });
              return found;
            };
          },
        });
      },
    }) as Db;
    expect(await verifyMagicLink(req.token, { db: racing, now: () => T0 })).toEqual({ ok: false, reason: "invalid" });
    expect(await db.user.count({ where: { email: "cousin@example.com" } })).toBe(0);
  });

  it("stops minting once an address holds three live links, the same for a member and a stranger", async () => {
    await db.user.create({ data: { email: "grandma@example.com", role: "ADMIN" } });
    const member: string[] = [];
    const stranger: string[] = [];
    let first: string | undefined;
    for (let i = 0; i < 6; i++) {
      const m = await requestMagicLink("grandma@example.com", deps());
      if (m.ok) first ??= m.token;
      member.push(m.ok ? "minted" : m.reason);
      const s = await requestMagicLink("stranger@example.com", deps());
      stranger.push(s.ok ? "minted" : s.reason === "not_invited" ? "minted" : s.reason);
    }
    expect(MAX_OUTSTANDING_LINKS).toBe(3);
    expect(member).toEqual(["minted", "minted", "minted", "recently_sent", "recently_sent", "recently_sent"]);
    expect(stranger).toEqual(member);
    // Nobody locked grandma out: the links she was sent still work.
    expect(await checkMagicLink(first!, deps())).toMatchObject({ ok: true });
    expect((await verifyMagicLink(first!, deps())).ok).toBe(true);
    // Using one makes room for one more.
    expect((await requestMagicLink("grandma@example.com", deps())).ok).toBe(true);
    // Once they have expired, a fresh one can be asked for.
    const later = new Date(T0.getTime() + 16 * 60 * 1000);
    expect((await requestMagicLink("grandma@example.com", deps(later))).ok).toBe(true);
  });

  it("counts concurrent requests for one address one at a time", async () => {
    await db.user.create({ data: { email: "grandma@example.com", role: "ADMIN" } });
    const results = await Promise.all(Array.from({ length: 10 }, () => requestMagicLink("grandma@example.com", deps())));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  it("gives two links pressed at once for a new admin the same account, not an error", async () => {
    const a = await requestMagicLink("first@example.com", deps());
    const b = await requestMagicLink("first@example.com", deps());
    if (!a.ok || !b.ok) throw new Error();
    const [ra, rb] = await Promise.all([verifyMagicLink(a.token, deps()), verifyMagicLink(b.token, deps())]);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(ra.userId).toBe(rb.userId);
    expect([ra.isNewUser, rb.isNewUser].sort()).toEqual([false, true]);
  });

  it("gives two links pressed at once for an invitee the same account", async () => {
    const admin = await db.user.create({ data: { email: "owner@example.com", role: "ADMIN" } });
    await createInvite("cousin@example.com", admin.id, "MEMBER", deps());
    const a = await requestMagicLink("cousin@example.com", deps());
    const b = await requestMagicLink("cousin@example.com", deps());
    if (!a.ok || !b.ok) throw new Error();
    const [ra, rb] = await Promise.all([verifyMagicLink(a.token, deps()), verifyMagicLink(b.token, deps())]);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(ra.userId).toBe(rb.userId);
    expect(await db.user.count({ where: { email: "cousin@example.com" } })).toBe(1);
  });

  it("takes only an address's second and third live link from the mail allowance, and gives back a withdrawn one", async () => {
    await db.user.create({ data: { email: "grandma@example.com", role: "ADMIN" } });
    let taken = 0;
    const mail = { take: () => (taken < 1 ? (taken++, true) : false), giveBack: () => void taken-- };
    const first = await requestMagicLink("grandma@example.com", { ...deps(), mail });
    expect(first).toMatchObject({ ok: true, charged: false });
    const second = await requestMagicLink("grandma@example.com", { ...deps(), mail });
    expect(second).toMatchObject({ ok: true, charged: true });
    expect(await requestMagicLink("grandma@example.com", { ...deps(), mail })).toEqual({ ok: false, reason: "busy" });
    if (!second.ok) throw new Error();
    await withdrawMagicLink(second.token, true, { db, mail });
    expect(taken).toBe(0);
    expect(await checkMagicLink(second.token, deps())).toEqual({ ok: false, reason: "invalid" });
    // A stranger's second request is charged exactly like a member's.
    let strangerTaken = 0;
    const strangerMail = { take: () => (strangerTaken++, true), giveBack: () => {} };
    await requestMagicLink("stranger@example.com", { ...deps(), mail: strangerMail });
    await requestMagicLink("stranger@example.com", { ...deps(), mail: strangerMail });
    expect(strangerTaken).toBe(1);
  });

  it("clears links a day past expiry out of the whole table, on requests and in the daily purge", async () => {
    await db.user.create({ data: { email: "grandma@example.com", role: "ADMIN" } });
    const old = await requestMagicLink("grandma@example.com", deps());
    if (!old.ok) throw new Error();
    for (let i = 0; i < 5; i++) await requestMagicLink(`stranger${i}@example.com`, deps());
    // Within the day's grace an old link is still recognised, so its owner is told it expired.
    const later = new Date(T0.getTime() + 16 * 60 * 1000);
    await requestMagicLink("someone@example.com", deps(later));
    expect(await db.magicLinkToken.count()).toBe(7);
    expect(await checkMagicLink(old.token, deps(later))).toEqual({ ok: false, reason: "expired" });
    expect(await purgeExpiredMagicLinks(deps(later))).toBe(0);
    // A day on, a request sweeps them.
    const nextDay = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
    await requestMagicLink("someone-else@example.com", deps(nextDay));
    expect(await db.magicLinkToken.count()).toBe(1);
    // And the daily purge gets whatever is left.
    await requestMagicLink("third@example.com", deps(nextDay));
    const dayAfter = new Date(T0.getTime() + 50 * 60 * 60 * 1000);
    expect(await purgeExpiredMagicLinks(deps(dayAfter))).toBe(2);
    expect(await db.magicLinkToken.count()).toBe(0);
  });

  it("shows only enough of an address to recognise it", () => {
    expect(maskEmail("grandma@example.com")).toBe("g•••@example.com");
    expect(maskEmail("x")).toBe("•••");
  });

  it("looking at a link does not use it up", async () => {
    const req = await requestMagicLink("first@example.com", deps());
    if (!req.ok) throw new Error();
    expect(await checkMagicLink(req.token, deps())).toEqual({ ok: true, email: "first@example.com" });
    expect(await checkMagicLink(req.token, deps())).toEqual({ ok: true, email: "first@example.com" });
    expect((await verifyMagicLink(req.token, deps())).ok).toBe(true);
    expect(await checkMagicLink(req.token, deps())).toEqual({ ok: false, reason: "used" });
    expect(await checkMagicLink("nope", deps())).toEqual({ ok: false, reason: "invalid" });
    expect(await checkMagicLink("", deps())).toEqual({ ok: false, reason: "invalid" });
    const later = new Date(T0.getTime() + 16 * 60 * 1000);
    const again = await requestMagicLink("first@example.com", deps());
    if (!again.ok) throw new Error();
    expect(await checkMagicLink(again.token, deps(later))).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts an invite and applies its role", async () => {
    const admin = await db.user.create({ data: { email: "owner@example.com", role: "ADMIN" } });
    await createInvite("cousin@example.com", admin.id, "MEMBER", deps());
    const req = await requestMagicLink("cousin@example.com", deps());
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const res = await verifyMagicLink(req.token, deps());
    expect(res.ok).toBe(true);
    const user = await db.user.findUniqueOrThrow({ where: { email: "cousin@example.com" } });
    expect(user.role).toBe("MEMBER");
    const invite = await db.invite.findFirstOrThrow({ where: { email: "cousin@example.com" } });
    expect(invite.acceptedAt).not.toBeNull();
  });

  it("is single-use", async () => {
    const req = await requestMagicLink("first@example.com", deps());
    if (!req.ok) throw new Error();
    expect((await verifyMagicLink(req.token, deps())).ok).toBe(true);
    expect(await verifyMagicLink(req.token, deps())).toEqual({ ok: false, reason: "used" });
  });

  it("expires after 15 minutes", async () => {
    const req = await requestMagicLink("first@example.com", deps());
    if (!req.ok) throw new Error();
    const later = new Date(T0.getTime() + 16 * 60 * 1000);
    expect(await verifyMagicLink(req.token, deps(later))).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects unknown tokens", async () => {
    expect(await verifyMagicLink("nope", deps())).toEqual({ ok: false, reason: "invalid" });
  });
});
