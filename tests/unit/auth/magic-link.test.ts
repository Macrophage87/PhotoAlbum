import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createInvite, requestMagicLink, verifyMagicLink } from "@/lib/auth/magic-link";
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

  it("allows ADMIN_EMAIL even when other users exist", async () => {
    await db.user.create({ data: { email: "owner@example.com", role: "MEMBER" } });
    const req = await requestMagicLink("boss@example.com", deps(T0, "boss@example.com"));
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const res = await verifyMagicLink(req.token, deps(T0, "boss@example.com"));
    expect(res.ok).toBe(true);
    const user = await db.user.findUniqueOrThrow({ where: { email: "boss@example.com" } });
    expect(user.role).toBe("ADMIN");
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
