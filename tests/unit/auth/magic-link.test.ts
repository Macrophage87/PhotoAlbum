import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkMagicLink, createInvite, maskEmail, requestMagicLink, verifyMagicLink } from "@/lib/auth/magic-link";
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
