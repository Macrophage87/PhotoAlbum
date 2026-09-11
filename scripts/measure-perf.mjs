/* Times the first paint of the gallery and timeline of the perf trip. Not run in CI; numbers go in the commit message.
   Usage: E2E_BASE_URL=http://localhost:3200 node scripts/measure-perf.mjs  (after scripts/seed-perf.ts on that server's database) */
import "dotenv/config";
import { chromium } from "@playwright/test";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";

const base = process.env.E2E_BASE_URL ?? "http://localhost:3200";
const dbUrl = process.env.PERF_DATABASE_URL ?? process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?.*)?$/, "/$1_e2e$2");
const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();

async function magicLink() {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  const token = randomBytes(32).toString("base64url");
  await c.query('INSERT INTO "MagicLinkToken" (id, email, "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval \'15 minutes\')', [randomBytes(12).toString("hex"), email, createHash("sha256").update(token).digest("hex")]);
  await c.end();
  return `${base}/auth/verify?token=${token}`;
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage();
await page.goto(await magicLink());
await page.waitForURL("**/");
for (const path of ["/trips/perf-3000/photos", "/trips/perf-3000/timeline", "/trips/perf-3000/photos", "/trips/perf-3000/timeline"]) {
  const t0 = Date.now();
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  const goto = Date.now() - t0;
  const paint = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return { ttfb: Math.round(nav.responseStart), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null };
  });
  console.log(`${path}: goto ${goto} ms, ttfb ${paint.ttfb} ms, first contentful paint ${paint.fcp} ms, DOMContentLoaded ${paint.domContentLoaded} ms`);
}
await browser.close();
