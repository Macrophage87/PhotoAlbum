import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createInvite, requestMagicLink } from "@/lib/auth/magic-link";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "", sessions: [] as string[], destroyed: 0, signedIn: false, headers: new Headers(), mail: [] as { to: string; text: string }[] }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "owner@example.com", name: null, role: "ADMIN" }),
  getViewer: async () => (who.signedIn ? { kind: "user", user: { id: who.id } } : { kind: "anonymous", user: null }),
}));
vi.mock("@/lib/auth/session", () => ({
  createSession: async (userId: string) => void who.sessions.push(userId),
  destroySession: async () => void who.destroyed++,
}));
vi.mock("@/lib/auth/email", () => ({ magicLinkEmail: (to: string, link: string) => ({ to, text: link }), sendMail: async (m: { to: string; text: string }) => void who.mail.push(m) }));
vi.mock("@/lib/google/account", () => ({ disconnectGoogleAccount: async () => {} }));
vi.mock("next/headers", () => ({ headers: async () => who.headers }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { removeMember, revokeInvite } from "@/app/admin/actions";
import { confirmSignIn } from "@/app/auth/verify/actions";
import { requestSignIn } from "@/app/auth/signin/actions";
import { POST as signOut } from "@/app/auth/signout/route";

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe("sign-in links and the Admin page", () => {
  beforeEach(async () => {
    await resetTestDb();
    who.sessions = [];
    who.destroyed = 0;
    who.signedIn = false;
    who.mail = [];
    who.headers = new Headers();
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

  it("revoking a stale invite for somebody who is already a member leaves their sign-in links alone", async () => {
    await createInvite("cousin@example.com", who.id, "MEMBER", { db });
    await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    const req = await requestMagicLink("cousin@example.com", { db });
    if (!req.ok) throw new Error();
    const invite = await db.invite.findFirstOrThrow({ where: { email: "cousin@example.com" } });
    await revokeInvite(invite.id);
    expect(await db.invite.count({ where: { email: "cousin@example.com" } })).toBe(0);
    expect(await db.magicLinkToken.count({ where: { email: "cousin@example.com" } })).toBe(1);
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

  it("a second tap on a used link, already signed in, just carries on", async () => {
    const req = await requestMagicLink("owner@example.com", { db });
    if (!req.ok) throw new Error();
    await expect(confirmSignIn(form({ token: req.token, next: "/trips/maine" }))).rejects.toThrow("REDIRECT:/trips/maine");
    who.signedIn = true;
    await expect(confirmSignIn(form({ token: req.token, next: "/trips/maine" }))).rejects.toThrow("REDIRECT:/trips/maine");
    expect(who.sessions).toEqual([who.id]);
    // An invalid link is still an error, signed in or not.
    await expect(confirmSignIn(form({ token: "nope" }))).rejects.toThrow("REDIRECT:/auth/signin?error=invalid");
  });

  it("the sign-in form keys its limit on the proxy's own X-Forwarded-For entry and says when it is reached", async () => {
    // The requester varies the entries it writes itself; the last one, which the proxy appended, stays the same.
    for (let i = 0; i < 3; i++) {
      who.headers = new Headers({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.50` });
      expect(await requestSignIn({ status: "idle" }, form({ email: "owner@example.com" }))).toEqual({ status: "sent", email: "owner@example.com" });
    }
    who.headers = new Headers({ "x-forwarded-for": "10.0.0.99, 203.0.113.50" });
    expect(await requestSignIn({ status: "idle" }, form({ email: "owner@example.com" }))).toEqual({
      status: "error",
      message: "Too many sign-in links were asked for just now. Please wait 10 minutes and try again.",
    });
    expect(who.mail).toHaveLength(3);
    // The owner's own address is untouched by that client's requests.
    who.headers = new Headers({ "x-forwarded-for": "203.0.113.50, 198.51.100.7" });
    expect(await requestSignIn({ status: "idle" }, form({ email: "owner@example.com" }))).toEqual({ status: "sent", email: "owner@example.com" });
    expect(who.mail).toHaveLength(4);
    expect(who.mail[3]!.text).toMatch(/\/auth\/verify\?token=/);
  });

  it("sign-out refuses another site's form and keeps the cookie", async () => {
    const evil = new Request("https://album.example/auth/signout", { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect((await signOut(evil)).status).toBe(403);
    const legacy = new Request("https://album.example/auth/signout", { method: "POST", headers: { origin: "https://evil.example", host: "album.example" } });
    expect((await signOut(legacy)).status).toBe(403);
    expect(who.destroyed).toBe(0);
    const own = new Request("https://album.example/auth/signout", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    const res = await signOut(own);
    expect(res.status).toBe(303);
    expect(who.destroyed).toBe(1);
  });
});
