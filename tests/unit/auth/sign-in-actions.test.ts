import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createInvite, requestMagicLink } from "@/lib/auth/magic-link";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", sessions: [] as string[] }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "owner@example.com", name: null, role: "ADMIN" }) }));
vi.mock("@/lib/auth/session", () => ({ createSession: async (userId: string) => void who.sessions.push(userId) }));
vi.mock("@/lib/google/account", () => ({ disconnectGoogleAccount: async () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { removeMember, revokeInvite } from "@/app/admin/actions";
import { confirmSignIn } from "@/app/auth/verify/actions";

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe("sign-in links and the Admin page", () => {
  beforeEach(async () => {
    await resetTestDb();
    who.sessions = [];
    who.id = (await db.user.create({ data: { email: "owner@example.com", role: "ADMIN" } })).id;
  });

  it("removing a member voids the sign-in link they already had", async () => {
    const cousin = await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    const req = await requestMagicLink("cousin@example.com", { db });
    if (!req.ok) throw new Error();
    await removeMember(cousin.id);
    expect(await db.magicLinkToken.count({ where: { email: "cousin@example.com" } })).toBe(0);
    await expect(confirmSignIn(form({ token: req.token }))).rejects.toThrow("REDIRECT:/auth/signin?error=invalid");
    expect(await db.user.count({ where: { email: "cousin@example.com" } })).toBe(0);
    expect(who.sessions).toEqual([]);
  });

  it("revoking an invite voids the sign-in link the invitee already asked for", async () => {
    await createInvite("cousin@example.com", who.id, "MEMBER", { db });
    const req = await requestMagicLink("cousin@example.com", { db });
    if (!req.ok) throw new Error();
    const invite = await db.invite.findFirstOrThrow({ where: { email: "cousin@example.com" } });
    await revokeInvite(invite.id);
    expect(await db.magicLinkToken.count({ where: { email: "cousin@example.com" } })).toBe(0);
    await expect(confirmSignIn(form({ token: req.token }))).rejects.toThrow("REDIRECT:/auth/signin?error=invalid");
    expect(await db.user.count({ where: { email: "cousin@example.com" } })).toBe(0);
  });

  it("the Sign in button starts a session and goes on to a same-site page only", async () => {
    const one = await requestMagicLink("owner@example.com", { db });
    if (!one.ok) throw new Error();
    await expect(confirmSignIn(form({ token: one.token, next: "/trips/maine" }))).rejects.toThrow("REDIRECT:/trips/maine");
    expect(who.sessions).toEqual([who.id]);
    const two = await requestMagicLink("owner@example.com", { db });
    if (!two.ok) throw new Error();
    await expect(confirmSignIn(form({ token: two.token, next: "/\t/evil.example.com" }))).rejects.toThrow(/^REDIRECT:\/$/);
    await expect(confirmSignIn(form({ token: two.token }))).rejects.toThrow("REDIRECT:/auth/signin?error=used");
  });
});
