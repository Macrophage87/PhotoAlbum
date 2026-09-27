import type { Db } from "@/lib/db";
import { generateToken, hashToken, normalizeEmail } from "./tokens";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type MagicLinkDeps = {
  db: Db;
  adminEmail?: string;
  now?: () => Date;
};

/** How many unused, unexpired links an address may hold before asking again sends nothing new. */
export const MAX_OUTSTANDING_LINKS = 3;

/** The shared allowance of sign-in mail (SIGN_IN_MAIL_PER_HOUR): take one, or give one back for mail never sent. */
export type MailAllowance = { take(): boolean; giveBack(): void };

export type RequestResult =
  | { ok: true; token: string; email: string; charged: boolean }
  | { ok: false; reason: "not_invited" | "recently_sent" | "busy" };

/** How many expired links one request clears out of the whole table on its way (the daily purge gets the rest). */
const EXPIRED_SWEEP_BATCH = 100;
/**
 * Links are kept a day past expiry before they are swept, so somebody clicking an old one is still told it has
 * expired or was already used, rather than that it is not valid.
 */
export const EXPIRED_LINK_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether an email may sign in and, if so, mint a single-use token.
 * Allowed when: an account exists, a pending invite exists, or the address may bootstrap the
 * admin account. When ADMIN_EMAIL is configured only that address can bootstrap, and only while the
 * album has no admin; without it, the first address to sign in on an empty database becomes the admin.
 *
 * However many people ask, an address never holds more than MAX_OUTSTANDING_LINKS live links: past that nothing
 * is minted or sent ("recently_sent"), and the links already in its inbox keep working, so asking on somebody's
 * behalf can neither flood them nor lock them out. An address that may not sign in is charged exactly the same
 * way, with a placeholder whose raw token nobody ever sees, so the answers never tell a member from a stranger.
 *
 * An address's first live link always goes out. Only a second or third is taken from the shared mail allowance,
 * so whoever fills that allowance can delay repeat links but never stop anybody signing in; strangers are charged
 * the same, so how fast it fills says nothing about membership.
 */
export async function requestMagicLink(rawEmail: string, deps: MagicLinkDeps & { mail?: MailAllowance }): Promise<RequestResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const email = normalizeEmail(rawEmail);

  return db.$transaction(async (tx) => {
    // One request per address at a time, so concurrent asks cannot all see room for one more.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`magic-link:${email}`}))::text`;
    // Links a day past expiry are no use to anybody: sweep a bounded batch, skipping rows another request holds.
    const stale = new Date(now.getTime() - EXPIRED_LINK_GRACE_MS);
    await tx.$executeRaw`DELETE FROM "MagicLinkToken" WHERE id IN (SELECT id FROM "MagicLinkToken" WHERE "expiresAt" <= ${stale} LIMIT ${EXPIRED_SWEEP_BATCH} FOR UPDATE SKIP LOCKED)`;
    const outstanding = await tx.magicLinkToken.count({ where: { email, usedAt: null, expiresAt: { gt: now } } });
    if (outstanding >= MAX_OUTSTANDING_LINKS) return { ok: false, reason: "recently_sent" } as const;
    const mail = outstanding > 0 ? deps.mail : undefined;
    if (mail && !mail.take()) return { ok: false, reason: "busy" } as const;
    const charged = Boolean(mail);

    const [user, invite, counts] = await Promise.all([
      tx.user.findUnique({ where: { email } }),
      tx.invite.findFirst({ where: { email, acceptedAt: null, expiresAt: { gt: now } } }),
      accountCounts(tx),
    ]);
    const allowed = Boolean(user) || Boolean(invite) || canBootstrapAdmin(email, counts, deps.adminEmail);
    const token = generateToken();
    await tx.magicLinkToken.create({
      // A stranger's placeholder is hashed from a token nobody is sent, so it can never be used.
      data: { email, tokenHash: hashToken(allowed ? token : generateToken()), expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS) },
    });
    return allowed ? ({ ok: true, token, email, charged } as const) : ({ ok: false, reason: "not_invited" } as const);
  });
}

/**
 * A link whose email could not be sent: withdraw it, so the address is not told a link is on its way when none
 * is, and hand back what it took from the mail allowance.
 */
export async function withdrawMagicLink(token: string, charged: boolean, deps: MagicLinkDeps & { mail?: MailAllowance }): Promise<void> {
  await deps.db.magicLinkToken.deleteMany({ where: { tokenHash: hashToken(token), usedAt: null } });
  if (charged) deps.mail?.giveBack();
}

/** The daily purge: every link more than a day past expiry, used or not (placeholders included). */
export async function purgeExpiredMagicLinks(deps: MagicLinkDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const stale = new Date(now.getTime() - EXPIRED_LINK_GRACE_MS);
  const { count } = await deps.db.magicLinkToken.deleteMany({ where: { expiresAt: { lte: stale } } });
  return count;
}

export type AccountCounts = { users: number; admins: number };

function accountCounts(db: Pick<Db, "user">): Promise<AccountCounts> {
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
  // Being removed: the address has no account to sign in to any more.
  if (existing?.removingAt) return { ok: false, reason: "invalid" };
  if (existing) return { ok: true, userId: existing.id, email, isNewUser: false };

  const invite = await db.invite.findFirst({ where: { email, acceptedAt: null, expiresAt: { gt: now } } });
  const bootstrap = canBootstrapAdmin(email, await accountCounts(db), deps.adminEmail);
  if (!invite && !bootstrap) return accountMadeMeanwhile(db, email);
  const role = bootstrap ? "ADMIN" : invite?.role ?? "MEMBER";

  // The invite is claimed in the same transaction that creates the account, and only if it is still pending: an
  // admin revoking it at this very moment either wins (no account) or finds it already accepted.
  const user = await db
    .$transaction(async (tx) => {
      if (invite) {
        const accepted = await tx.invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: now } });
        if (accepted.count === 0 && !bootstrap) return null;
      }
      return tx.user.create({ data: { email, role } });
    })
    .catch((err: unknown) => {
      // Another of this address's links was pressed at the same moment and created the account first.
      if (isUniqueViolation(err)) return null;
      throw err;
    });
  if (user) return { ok: true, userId: user.id, email, isNewUser: true };
  return accountMadeMeanwhile(db, email);
}

/**
 * The invite or the address was taken by another of this address's links, pressed at the same moment, whose
 * sign-in has committed by now (a claim waits on its lock): that account is this person's too. Otherwise the
 * invite was revoked, or there never was one.
 */
async function accountMadeMeanwhile(db: Db, email: string): Promise<VerifyResult> {
  const created = await db.user.findUnique({ where: { email } });
  if (created) return { ok: true, userId: created.id, email, isNewUser: false };
  return { ok: false, reason: "invalid" };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
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
