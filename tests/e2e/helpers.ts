import "dotenv/config";
import { Client } from "pg";
import { createHash, randomBytes } from "node:crypto";
import type { BrowserContext } from "@playwright/test";

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

export async function resetDb() {
  await withDb(async (c) => {
    await c.query('TRUNCATE "_TripParticipants", "_ActivityParticipants", "Visit", "VisitSalt", "AnimalDetection", "TakeoutImport", "GoogleAccount", "MediaSimilarity", "Face", "FaceCluster", "Person", "MediaAnnotationRaw", "AnnotationBatch", "AppSetting", "CollectionItem", "Collection", "PhotoLink", "TrackStats", "Track", "Photo", "Activity", "Trip", "Session", "MagicLinkToken", "Invite", "User" CASCADE');
    // Jobs left by a previous run (a server killed mid-job) would otherwise sit until they expire.
    await c.query("DELETE FROM pgboss.job").catch(() => {});
  });
}

/** Mint a sign-in token exactly the way the app does, without email. */
export async function magicLinkFor(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await withDb((c) => c.query('INSERT INTO "MagicLinkToken" (id, email, "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval \'15 minutes\')', [randomBytes(12).toString("hex"), email.toLowerCase(), hash]));
  return `/auth/verify?token=${token}`;
}

export async function signIn(context: BrowserContext, email: string) {
  const page = await context.newPage();
  await page.goto(await magicLinkFor(email));
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
