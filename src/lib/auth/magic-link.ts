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
 * Allowed when: an account exists, a pending invite exists, or the address may bootstrap the
 * admin account. When ADMIN_EMAIL is configured only that address can bootstrap, and only while the
 * album has no admin; without it, the first address to sign in on an empty database becomes the admin.
 */
export async function requestMagicLink(rawEmail: string, deps: MagicLinkDeps): Promise<RequestResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const email = normalizeEmail(rawEmail);

  const [user, invite, counts] = await Promise.all([
    db.user.findUnique({ where: { email } }),
    db.invite.findFirst({ where: { email, acceptedAt: null, expiresAt: { gt: now } } }),
    accountCounts(db),
  ]);
  const allowed = Boolean(user) || Boolean(invite) || canBootstrapAdmin(email, counts, deps.adminEmail);
  if (!allowed) return { ok: false, reason: "not_invited" };

  const token = generateToken();
  await db.magicLinkToken.create({
    data: { email, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS) },
  });
  return { ok: true, token, email };
}

export type AccountCounts = { users: number; admins: number };

function accountCounts(db: Db): Promise<AccountCounts> {
  return Promise.all([db.user.count(), db.user.count({ where: { role: "ADMIN" } })]).then(([users, admins]) => ({ users, admins }));
}

/**
 * ADMIN_EMAIL, when set, is the only address that may create the admin account, and only while there is no admin:
 * once an admin exists it is an ordinary address, so removing that account from the Admin page sticks.
 */
export function canBootstrapAdmin(email: string, counts: AccountCounts, adminEmail?: string): boolean {
  if (adminEmail && adminEmail.trim()) return counts.admins === 0 && normalizeEmail(adminEmail) === email;
  return counts.users === 0;
}

export type VerifyResult =
  | { ok: true; userId: string; email: string; isNewUser: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Look at a magic-link token without using it, for the page the emailed link opens. Mail scanners fetch links
 * before the person does, so only the button on that page (a POST) may consume it.
 */
export async function checkMagicLink(token: string, deps: MagicLinkDeps): Promise<{ ok: true; email: string } | { ok: false; reason: "invalid" | "expired" | "used" }> {
  const now = deps.now?.() ?? new Date();
  const record = token ? await deps.db.magicLinkToken.findUnique({ where: { tokenHash: hashToken(token) } }) : null;
  if (!record) return { ok: false, reason: "invalid" };
  if (record.usedAt) return { ok: false, reason: "used" };
  if (record.expiresAt.getTime() < now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, email: record.email };
}

/**
 * An address shown only enough to recognise: "a•••@example.com". The link's page says whose it is, so somebody
 * handed another person's link notices before signing in as them, without the page spelling the address out.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * Consume a magic-link token. Creates the user on first sign-in, honouring a pending invite's role
 * and promoting the bootstrap admin. Whether the address may have an account is decided again here, not
 * just when the link was sent: the member may have been removed, or the invite revoked, in between.
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
  const bootstrap = canBootstrapAdmin(email, await accountCounts(db), deps.adminEmail);
  if (!invite && !bootstrap) return { ok: false, reason: "invalid" };
  const role = bootstrap ? "ADMIN" : invite?.role ?? "MEMBER";

  // The invite is claimed in the same transaction that creates the account, and only if it is still pending: an
  // admin revoking it at this very moment either wins (no account) or finds it already accepted.
  const user = await db.$transaction(async (tx) => {
    if (invite) {
      const accepted = await tx.invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: now } });
      if (accepted.count === 0 && !bootstrap) return null;
    }
    return tx.user.create({ data: { email, role } });
  });
  if (!user) return { ok: false, reason: "invalid" };
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
