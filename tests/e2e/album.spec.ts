import { expect, test } from "@playwright/test";
import path from "node:path";
import { createTrip, resetDb, setVisibility, signIn, withDb } from "./helpers";

// Must match ADMIN_EMAIL as set by scripts/e2e-server.mjs: only that address may bootstrap the admin account.
const ADMIN = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.com";
const fixture = (n: string) => path.join(__dirname, "../fixtures", n);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await resetDb();
});

test("first sign-in bootstraps the admin and lands on the trip grid", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Trips" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
  const role = await withDb((c) => c.query('SELECT role FROM "User" WHERE email = $1', [ADMIN]));
  expect(role.rows[0].role).toBe("ADMIN");
});

test("a used or bad sign-in link is rejected", async ({ page }) => {
  await page.goto("/auth/verify?token=not-a-real-token");
  await expect(page).toHaveURL(/\/auth\/signin\?error=invalid/);
  await expect(page.getByText("isn't valid")).toBeVisible();
});

test("uploading a photo processes it and assigns it to the trip by date", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await createTrip({ slug: "acadia", title: "Acadia", start: "2025-08-10", end: "2025-08-16", ownerEmail: ADMIN });
  await page.goto("/upload");
  await page.setInputFiles('input[type="file"]', fixture("photo-with-gps.jpg"));
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("1 of 1 uploaded.")).toBeVisible();
  await page.goto("/trips/acadia/photos");
  await expect(page.getByRole("heading", { name: /1 photo/ })).toBeVisible();
  const row = await withDb((c) => c.query('SELECT status, "takenAtSource", lat FROM "Photo" LIMIT 1'));
  expect(row.rows[0]).toMatchObject({ status: "READY", takenAtSource: "EXIF_OFFSET" });
  expect(Number(row.rows[0].lat)).toBeCloseTo(44.35, 3);
});

test("importing a GPX file creates an activity with stats and a track on the map", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/trips/acadia/import");
  await page.setInputFiles('input[type="file"]', fixture("sample-hr.gpx"));
  await expect(page.getByRole("link", { name: "Ocean Path loop" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: "Ocean Path loop" }).click();
  await expect(page.getByText("Distance")).toBeVisible();
  await expect(page.getByText("Avg heart rate")).toBeVisible();
  await expect(page.getByText(/136 bpm/)).toBeVisible();
});

test("private trips are hidden from anonymous visitors", async ({ browser }) => {
  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.goto("/trips/acadia");
  await expect(page).toHaveURL(/\/auth\/signin/);
  await page.goto("/");
  await expect(page.getByText("Nothing public yet")).toBeVisible();
  await anon.close();
});

test("a share link opens the trip read-only, and stops working when rotated", async ({ browser }) => {
  await setVisibility("acadia", "LINK", "e2e-share-token");
  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.goto("/share/e2e-share-token/photos");
  await expect(page.getByText("Shared with you")).toBeVisible();
  const img = page.locator("img[src*='/api/photos/']").first();
  await expect(img).toBeVisible();
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByTestId("share-facebook")).toHaveAttribute("href", /%2Fshare%2Fe2e-share-token/);
  // Link previews fetch the cover without a cookie, so the og:image URL must work on its own.
  const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(ogImage).toContain("share=e2e-share-token");
  const crawler = await browser.newContext();
  const bare = await crawler.request.get(ogImage!);
  expect(bare.ok()).toBe(true);
  await crawler.close();
  await setVisibility("acadia", "LINK", "rotated-token");
  await page.goto("/share/e2e-share-token");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await anon.close();
});

test("public trips are browsable anonymously without edit controls", async ({ browser }) => {
  await setVisibility("acadia", "PUBLIC");
  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Acadia/ })).toBeVisible();
  await page.goto("/trips/acadia");
  await expect(page.getByRole("heading", { name: "Acadia" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Family sign in" })).toBeVisible();
  const fb = page.getByTestId("share-facebook");
  await expect(fb).toHaveAttribute("href", /facebook\.com\/sharer\/sharer\.php\?u=.*%2Ftrips%2Facadia/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Acadia");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/api\/photos\//);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.goto("/trips/acadia/settings");
  await expect(page).toHaveURL(/\/auth\/signin/);
  await setVisibility("acadia", "PRIVATE");
  await page.goto("/trips/acadia");
  await expect(page).toHaveURL(/\/auth\/signin/);
  await anon.close();
});

test("a collection gathers photos from two trips and can be shared by link", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  await createTrip({ slug: "yosemite", title: "Yosemite", start: "2025-09-01", end: "2025-09-05", ownerEmail: ADMIN });
  await page.goto("/upload?trip=yosemite");
  await page.setInputFiles('input[type="file"]', fixture("photo-no-gps.jpg"));
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("1 of 1 uploaded.")).toBeVisible();

  await page.goto("/collections/new");
  await page.getByLabel("Title").fill("Best of 2025");
  await page.getByRole("button", { name: "Create collection" }).click();
  await expect(page).toHaveURL(/\/collections\/best-of-2025$/);
  await expect(page.getByRole("heading", { name: "Best of 2025" })).toBeVisible();

  const photos = await withDb((c) => c.query('SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug IN (\'acadia\', \'yosemite\') ORDER BY t.slug'));
  expect(photos.rows).toHaveLength(2);
  for (const row of photos.rows) {
    await page.goto(`/photos/${row.id}`);
    const box = page.getByLabel("Best of 2025");
    await box.check();
    await expect(page.getByRole("link", { name: "Open" })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Best of 2025")).toBeChecked();
  }
  await page.goto("/collections/best-of-2025/photos");
  await expect(page.getByRole("heading", { name: /2 photos/ })).toBeVisible();

  await page.goto("/collections/best-of-2025/settings");
  await page.getByLabel("Anyone with the link").check();
  await page.getByRole("button", { name: "Update visibility" }).click();
  const shareUrl = (await page.locator("code").first().textContent())!.trim();
  expect(shareUrl).toMatch(/\/share\/c\//);

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto("/collections/best-of-2025");
  await expect(anonPage).toHaveURL(/\/auth\/signin/);
  await anonPage.goto(shareUrl);
  await expect(anonPage.getByText("Shared with you")).toBeVisible();
  const imgs = anonPage.locator("img[src*='/api/photos/']");
  await expect(imgs).toHaveCount(2);
  for (const img of await imgs.all()) await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect(anonPage.getByRole("link", { name: "Settings" })).toHaveCount(0);
  const ogImage = await anonPage.locator('meta[property="og:image"]').getAttribute("content");
  expect(ogImage).toContain("kind=collection");
  const crawler = await browser.newContext();
  expect((await crawler.request.get(ogImage!)).ok()).toBe(true);
  await crawler.close();
  await anon.close();
});
