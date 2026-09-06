import type { Db } from "@/lib/db";
import { generateToken, hashToken, normalizeEmail } from "./tokens";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type MagicLinkDeps = {
  db: Db;
  adminEmail?: string;
  now?: () => Date;
};

export type RequestResult =
  | { ok: true; token: string; email: string }
  | { ok: false; reason: "not_invited" };

/**
 * Decide whether an email may sign in and, if so, mint a single-use token.
 * Allowed when: an account exists, a pending invite exists, nobody has signed up yet,
 * or the address is the configured ADMIN_EMAIL (admin bootstrap).
 */
export async function requestMagicLink(rawEmail: string, deps: MagicLinkDeps): Promise<RequestResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const email = normalizeEmail(rawEmail);

  const [user, invite, userCount] = await Promise.all([
    db.user.findUnique({ where: { email } }),
    db.invite.findFirst({ where: { email, acceptedAt: null, expiresAt: { gt: now } } }),
    db.user.count(),
  ]);
  const isBootstrapAdmin = deps.adminEmail ? normalizeEmail(deps.adminEmail) === email : false;
  const allowed = Boolean(user) || Boolean(invite) || userCount === 0 || isBootstrapAdmin;
  if (!allowed) return { ok: false, reason: "not_invited" };

  const token = generateToken();
  await db.magicLinkToken.create({
    data: { email, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS) },
  });
  return { ok: true, token, email };
}

export type VerifyResult =
  | { ok: true; userId: string; email: string; isNewUser: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Consume a magic-link token. Creates the user on first sign-in, honouring a pending invite's role
 * and promoting the bootstrap admin.
 */
export async function verifyMagicLink(token: string, deps: MagicLinkDeps): Promise<VerifyResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const record = await db.magicLinkToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record) return { ok: false, reason: "invalid" };
  if (record.usedAt) return { ok: false, reason: "used" };
  if (record.expiresAt.getTime() < now.getTime()) return { ok: false, reason: "expired" };

  // Mark used atomically; a concurrent verify of the same token loses here.
  const claimed = await db.magicLinkToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count === 0) return { ok: false, reason: "used" };

  const email = record.email;
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { ok: true, userId: existing.id, email, isNewUser: false };

  const invite = await db.invite.findFirst({ where: { email, acceptedAt: null, expiresAt: { gt: now } } });
  const userCount = await db.user.count();
  const isBootstrapAdmin = (deps.adminEmail ? normalizeEmail(deps.adminEmail) === email : false) || userCount === 0;
  const role = isBootstrapAdmin ? "ADMIN" : invite?.role ?? "MEMBER";

  const user = await db.user.create({ data: { email, role } });
  if (invite) await db.invite.update({ where: { id: invite.id }, data: { acceptedAt: now } });
  return { ok: true, userId: user.id, email, isNewUser: true };
}

/** Create an invite and return the raw token for the email link. */
export async function createInvite(
  rawEmail: string,
  invitedById: string,
  role: "ADMIN" | "MEMBER",
  deps: MagicLinkDeps,
): Promise<{ token: string; email: string }> {
  const now = deps.now?.() ?? new Date();
  const email = normalizeEmail(rawEmail);
  const token = generateToken();
  await deps.db.invite.create({
    data: { email, role, invitedById, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS) },
  });
  return { token, email };
}

/** Look up a pending invite by its raw token. */
export async function findInviteByToken(token: string, deps: MagicLinkDeps) {
  const now = deps.now?.() ?? new Date();
  const invite = await deps.db.invite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt.getTime() < now.getTime()) return null;
  return invite;
}
