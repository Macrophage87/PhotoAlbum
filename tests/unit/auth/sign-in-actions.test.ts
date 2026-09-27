import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { checkMagicLink, createInvite, requestMagicLink } from "@/lib/auth/magic-link";
import { resetTestDb } from "../helpers/reset";

const MAIL_PER_HOUR = vi.hoisted(() => {
  // Read once, when the first link is asked for; the last test runs into it.
  process.env.SIGN_IN_MAIL_PER_HOUR = "20";
  return 20;
});
const who = vi.hoisted(() => ({ id: "", sessions: [] as string[], destroyed: 0, signedIn: false, headers: new Headers(), mail: [] as { to: string; text: string }[] }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "owner@example.com", name: null, role: "ADMIN" }),
  getViewer: async () => (who.signedIn ? { kind: "user", user: { id: who.id } } : { kind: "anonymous", user: null }),
}));
vi.mock("@/lib/auth/session", () => ({
  createSession: async (userId: string) => void who.sessions.push(userId),
  destroySession: async () => void who.destroyed++,
}));
const mailer = vi.hoisted(() => ({ fail: false, hang: false, pending: [] as Promise<unknown>[] }));
vi.mock("@/lib/auth/email", () => ({
  magicLinkEmail: (to: string, link: string) => ({ to, text: link }),
  inviteEmail: (to: string, link: string) => ({ to, text: link }),
  sendMail: async (m: { to: string; text: string }) => {
    if (mailer.hang) return new Promise(() => {});
    if (mailer.fail) throw new Error("SMTP is down");
    who.mail.push(m);
  },
}));
// Work scheduled with after() runs once the answer has gone; the tests wait for it explicitly.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void mailer.pending.push(Promise.resolve().then(fn)),
}));
const google = vi.hoisted(() => ({ revoked: [] as { userId: string; token: string | null; memberStillThere: boolean }[] }));
vi.mock("@/lib/google/account", () => ({
  revokeRemovedConnection: async (userId: string, token: string | null) => {
    const { db } = await import("@/lib/db");
    google.revoked.push({ userId, token, memberStillThere: Boolean(await db.user.findUnique({ where: { id: userId } })) });
    return token ? "revoked" : "none";
  },
}));
vi.mock("next/headers", () => ({ headers: async () => who.headers }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { inviteMember, removeMember, revokeInvite } from "@/app/admin/actions";
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
    mailer.fail = false;
    mailer.hang = false;
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

  it("removes a member who made and filled collections, and revokes their Google connection only once they are gone", async () => {
    const cousin = await db.user.create({ data: { email: "cousin@example.com", role: "MEMBER" } });
    await db.googleAccount.create({ data: { userId: cousin.id, encryptedRefreshToken: "sealed" } });
    const photo = await db.photo.create({ data: { uploaderId: who.id, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } });
    const theirs = await db.collection.create({ data: { slug: "theirs", title: "Theirs", createdById: cousin.id } });
    const mine = await db.collection.create({ data: { slug: "mine", title: "Mine", createdById: who.id } });
    await db.collectionItem.create({ data: { collectionId: mine.id, photoId: photo.id, addedById: cousin.id } });
    await db.collectionItem.create({ data: { collectionId: theirs.id, photoId: photo.id, addedById: cousin.id } });
    google.revoked = [];
    await removeMember(cousin.id);
    expect(await db.user.count({ where: { id: cousin.id } })).toBe(0);
    expect((await db.collection.findUniqueOrThrow({ where: { id: theirs.id } })).createdById).toBe(who.id);
    expect((await db.collectionItem.findMany({ where: { photoId: photo.id } })).map((i) => i.addedById)).toEqual([who.id, who.id]);
    expect(await db.googleAccount.count()).toBe(0);
    expect(google.revoked).toEqual([{ userId: cousin.id, token: "sealed", memberStillThere: false }]);
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

  const ask = async (email: string, xff?: string) => {
    who.headers = new Headers(xff ? { "x-forwarded-for": xff } : {});
    const answer = await requestSignIn({ status: "idle" }, form({ email }));
    await Promise.all(mailer.pending.splice(0));
    return answer;
  };
  const TOO_MANY = { status: "error", message: "Too many sign-in links were asked for just now. Please wait 10 minutes and try again." };
  const RECENT = { status: "error", message: "If this address belongs to a family member, sign-in links have already gone to it in the last few minutes. Please use the newest one in that inbox." };

  it("the sign-in form keys its per-client limit on the proxy's own X-Forwarded-For entry", async () => {
    // The requester varies the entries it writes itself; the last one, which the proxy appended, stays the same.
    for (let i = 0; i < 20; i++) expect(await ask(`nobody${i}@example.com`, `10.0.0.${i}, 203.0.113.50`)).toEqual({ status: "sent", email: `nobody${i}@example.com` });
    expect(await ask("nobody99@example.com", "10.0.0.99, 203.0.113.50")).toEqual(TOO_MANY);
    // Another client is untouched.
    expect(await ask("nobody99@example.com", "203.0.113.50, 198.51.100.7")).toEqual({ status: "sent", email: "nobody99@example.com" });
    expect(who.mail).toHaveLength(0);
  });

  it("a flood from 2000 networks sends grandma at most three links, and she can still sign in with them", async () => {
    await db.user.create({ data: { email: "grandma@example.com", role: "MEMBER" } });
    const member: string[] = [];
    for (let i = 0; i < 2000; i++) member.push(JSON.stringify(await ask("grandma@example.com", `2001:db8:${i.toString(16)}:1::1`)));
    expect(who.mail).toHaveLength(3);
    expect(who.mail.every((m) => m.to === "grandma@example.com")).toBe(true);
    // Her own request is told to use the links she has, which work.
    expect(await ask("grandma@example.com", "198.51.100.7")).toEqual(RECENT);
    const token = new URL(who.mail[2]!.text).searchParams.get("token")!;
    expect(await checkMagicLink(token, { db })).toMatchObject({ ok: true });
    // A stranger's address is answered exactly the same way, request for request.
    const stranger: string[] = [];
    for (let i = 0; i < 2000; i++) stranger.push(JSON.stringify(await ask("stranger@example.com", `2001:db9:${i.toString(16)}:1::1`)).replace("stranger", "grandma"));
    expect(stranger).toEqual(member);
    expect(who.mail).toHaveLength(3);
  }, 120_000);

  it("without a proxy, repeat requests are told a link is on its way rather than refused", async () => {
    await db.user.create({ data: { email: "grandma@example.com", role: "MEMBER" } });
    const answers = [];
    for (let i = 0; i < 10; i++) answers.push(await ask("grandma@example.com"));
    expect(answers.slice(0, 3)).toEqual(Array(3).fill({ status: "sent", email: "grandma@example.com" }));
    expect(answers.slice(3)).toEqual(Array(7).fill(RECENT));
    expect(who.mail).toHaveLength(3);
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

  it("inviting somebody clears the placeholders their earlier requests left, so their first real ask is sent", async () => {
    for (let i = 0; i < 3; i++) await ask("cousin@example.com");
    expect(await ask("cousin@example.com")).toEqual(RECENT);
    expect(await inviteMember({ status: "idle" }, form({ email: "cousin@example.com", role: "MEMBER" }))).toEqual({ status: "sent", email: "cousin@example.com" });
    who.mail = [];
    expect(await ask("cousin@example.com")).toEqual({ status: "sent", email: "cousin@example.com" });
    expect(who.mail).toHaveLength(1);
  });

  it("answers before the email is sent, so a member's request takes no longer than a stranger's", async () => {
    await db.user.create({ data: { email: "grandma@example.com", role: "MEMBER" } });
    mailer.hang = true;
    who.headers = new Headers({ "x-forwarded-for": "198.51.100.30" });
    // With a mail server that never answers, the request still comes straight back.
    expect(await requestSignIn({ status: "idle" }, form({ email: "grandma@example.com" }))).toEqual({ status: "sent", email: "grandma@example.com" });
    mailer.pending.splice(0);
  });

  it("withdraws a link whose email could not be sent, so the next request is not told one is on its way", async () => {
    await db.user.create({ data: { email: "grandma@example.com", role: "MEMBER" } });
    mailer.fail = true;
    for (let i = 0; i < 3; i++) expect(await ask("grandma@example.com", "198.51.100.31")).toEqual({ status: "sent", email: "grandma@example.com" });
    expect(await db.magicLinkToken.count({ where: { email: "grandma@example.com" } })).toBe(0);
    mailer.fail = false;
    expect(await ask("grandma@example.com", "198.51.100.31")).toEqual({ status: "sent", email: "grandma@example.com" });
    expect(who.mail).toHaveLength(1);
  });

  // Last: it uses up the hourly allowance the whole file shares.
  it("past the hourly ceiling a first link still goes out; a repeat is told to wait, member or stranger", async () => {
    const BUSY = { status: "error", message: "The album has sent a lot of sign-in email in the last hour. Please try again a little later." };
    const sent = (email: string) => ({ status: "sent", email });
    // Fill the allowance with second links (first links are never counted).
    let i = 0;
    for (; i < 100; i++) {
      const email = `member${i}@example.com`;
      await db.user.create({ data: { email, role: "MEMBER" } });
      expect(await ask(email, `198.18.${i}.1`)).toEqual(sent(email));
      if (JSON.stringify(await ask(email, `198.18.${i}.1`)) === JSON.stringify(BUSY)) break;
    }
    expect(i).toBeLessThan(MAIL_PER_HOUR);
    // Somebody with no live link is still sent one.
    await db.user.create({ data: { email: "late@example.com", role: "MEMBER" } });
    expect(await ask("late@example.com", "198.19.0.1")).toEqual(sent("late@example.com"));
    // A repeat is told to wait, and a stranger's repeat is answered the same way.
    expect(await ask("late@example.com", "198.19.0.1")).toEqual(BUSY);
    expect(await ask("stranger@example.com", "198.19.0.2")).toEqual(sent("stranger@example.com"));
    expect(await ask("stranger@example.com", "198.19.0.2")).toEqual(BUSY);
    // An address that already holds three live links hears that first.
    await db.user.create({ data: { email: "full@example.com", role: "MEMBER" } });
    for (let n = 0; n < 3; n++) await requestMagicLink("full@example.com", { db });
    expect(await ask("full@example.com", "198.19.0.3")).toEqual({ status: "error", message: "If this address belongs to a family member, sign-in links have already gone to it in the last few minutes. Please use the newest one in that inbox." });
  });
});
