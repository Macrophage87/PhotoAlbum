import "dotenv/config";
import { Client } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

const dbUrl = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?.*)?$/, "/$1_e2e$2");

export async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** The e2e server's storage root, as scripts/e2e-server.mjs chooses it: one per e2e database. */
const photoRoot = process.env.E2E_PHOTO_ROOT ?? `/tmp/${dbUrl ? new URL(dbUrl).pathname.slice(1) : "photoalbum-e2e"}-photos`;

export async function resetDb() {
  await withDb(async (c) => {
    await c.query('TRUNCATE "_TripParticipants", "_ActivityParticipants", "Visit", "VisitSalt", "AnimalDetection", "TakeoutImport", "GoogleAccount", "MediaSimilarity", "Face", "FaceCluster", "Person", "MediaAnnotationRaw", "AnnotationBatch", "AppSetting", "CollectionItem", "Collection", "PhotoLink", "TrackStats", "Track", "Photo", "Activity", "Trip", "Session", "MagicLinkToken", "Invite", "User" CASCADE');
    // Jobs left by a previous run (a server killed mid-job) would otherwise sit until they expire.
    await c.query("DELETE FROM pgboss.job").catch(() => {});
    // Emptying AppSetting also took the install id and binding the worker gave the album as it started, while the
    // storage root's .album-install-id still holds them: the Admin page would call them two albums' and the sweeps
    // would stop. Bind the two again, keeping the marker's id (or a new one, on a root with none yet), as an admin's
    // re-bind would (src/lib/storage/identity.ts).
    const marker = path.join(photoRoot, ".album-install-id");
    const read = await readFile(marker, "utf8").then((t) => JSON.parse(t) as { installId?: string }, () => null).catch(() => null);
    const installId = read?.installId || randomUUID();
    const { rows } = await c.query<{ binding: string }>("SELECT system_identifier::text || ':' || current_database() AS binding FROM pg_control_system()");
    await mkdir(photoRoot, { recursive: true });
    await writeFile(marker, `${JSON.stringify({ installId, binding: rows[0].binding, heartbeatBinding: rows[0].binding, heartbeatAt: new Date().toISOString() })}\n`);
    await c.query(`INSERT INTO "AppSetting" (id, "installId", "installBinding", "updatedAt") VALUES ('app', $1, $2, now())`, [installId, rows[0].binding]);
  });
}

/** Mint a sign-in token exactly the way the app does, without email. */
export async function magicLinkFor(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await withDb((c) => c.query('INSERT INTO "MagicLinkToken" (id, email, "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval \'15 minutes\')', [randomBytes(12).toString("hex"), email.toLowerCase(), hash]));
  return `/auth/verify?token=${token}`;
}

/**
 * Mint a pending invite, as an admin's "Invite" does, so an address that is not yet a member may be given an
 * account. Nothing happens for an address that already is one, so a test may call it whatever ran before.
 */
export async function inviteFor(email: string, role: "ADMIN" | "MEMBER" = "MEMBER") {
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  await withDb((c) =>
    c.query(
      'INSERT INTO "Invite" (id, email, "tokenHash", role, "invitedById", "expiresAt") SELECT $1, $2, $3, $4::"Role", id, now() + interval \'14 days\' FROM "User" WHERE role = \'ADMIN\' AND NOT EXISTS (SELECT 1 FROM "User" WHERE email = $2) LIMIT 1',
      [randomBytes(12).toString("hex"), email.toLowerCase(), hash, role],
    ),
  );
}

/**
 * Press the link page's "Sign in" button once the page has settled (so the click is not made while React is still
 * hydrating the form), exactly once: a lost tap should fail the test, not be papered over by a second one.
 */
export async function pressSignIn(page: Page) {
  const at = page.url();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => u.toString() !== at, { timeout: 20_000 });
}

/** Open the emailed link and press its "Sign in" button: opening the link alone does not use it up. */
export async function signIn(context: BrowserContext, email: string) {
  const page = await context.newPage();
  await page.goto(await magicLinkFor(email));
  await pressSignIn(page);
  await page.waitForURL("**/");
  await page.close();
}

export async function createTrip(opts: { slug: string; title: string; start: string; end: string; visibility?: "PRIVATE" | "LINK" | "PUBLIC"; shareToken?: string | null; ownerEmail: string }) {
  return withDb(async (c) => {
    const u = await c.query('SELECT id FROM "User" WHERE email = $1', [opts.ownerEmail.toLowerCase()]);
    const id = randomBytes(12).toString("hex");
    await c.query(
      'INSERT INTO "Trip" (id, slug, title, "startDate", "endDate", timezone, "themeKey", visibility, "shareToken", "createdById", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())',
      [id, opts.slug, opts.title, opts.start, opts.end, "America/New_York", "lighthouse", opts.visibility ?? "PRIVATE", opts.shareToken ?? null, u.rows[0].id],
    );
    return id;
  });
}

export async function setVisibility(slug: string, visibility: "PRIVATE" | "LINK" | "PUBLIC", shareToken: string | null = null) {
  await withDb((c) => c.query('UPDATE "Trip" SET visibility = $2, "shareToken" = $3 WHERE slug = $1', [slug, visibility, shareToken]));
}
