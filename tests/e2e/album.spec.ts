import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { createTrip, resetDb, setVisibility, signIn, withDb } from "./helpers";

// Must match ADMIN_EMAIL as set by scripts/e2e-server.mjs: only that address may bootstrap the admin account.
const ADMIN = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.com";
const fixture = (n: string) => path.join(__dirname, "../fixtures", n);

/** Pick a file only once the page has hydrated, otherwise React's change handler is not attached yet and nothing uploads. */
async function chooseFile(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  await page.setInputFiles('input[type="file"]', fixture(name));
}

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
  await chooseFile(page, "photo-with-gps.jpg");
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
  await chooseFile(page, "sample-hr.gpx");
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
  await chooseFile(page, "photo-no-gps.jpg");
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
  // Sharing private-trip photos by link widens their exposure, so the form asks first.
  page.once("dialog", (d) => void d.accept());
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

test("exposure warnings fire when widening and when lowering, and bulk actions attach photos", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);

  // Raising the collection to PUBLIC exposes private-trip photos: the settings page warns and asks to confirm.
  await page.goto("/collections/best-of-2025/settings");
  await page.getByLabel(/^Public/).check();
  await expect(page.getByRole("note")).toContainText("anyone on the internet");
  let dialogText = "";
  page.once("dialog", (d) => { dialogText = d.message(); void d.accept(); });
  await page.getByRole("button", { name: "Update visibility" }).click();
  await expect(page.getByText("Share", { exact: true })).toBeVisible();
  expect(dialogText).toContain("anyone on the internet");

  // Lowering: Acadia is private, but its photo sits in the now-public collection, so the trip settings say so.
  await page.goto("/trips/acadia/settings");
  await expect(page.getByText("Still visible elsewhere")).toBeVisible();
  await expect(page.getByText(/also in the public collection Best of 2025/)).toBeVisible();

  // A photo with no date lands nowhere; attach it from the unassigned gallery, with a warning when the target is public.
  await page.goto("/upload");
  await chooseFile(page, "photo-no-exif.jpg");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  await page.goto("/photos");
  await expect(page.getByRole("heading", { name: "Photos without a trip" })).toBeVisible();
  await page.getByRole("button", { name: "Select photos" }).click();
  await page.locator("li button").first().click();
  await page.getByLabel("Collection to add to").selectOption({ label: "Best of 2025" });
  dialogText = "";
  page.once("dialog", (d) => { dialogText = d.message(); void d.accept(); });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("added to the collection");
  expect(dialogText).toContain("only family members could see");
  await page.getByRole("button", { name: "Select photos" }).click();
  await page.locator("li button").first().click();
  await page.getByLabel("Trip to move to").selectOption({ label: "Yosemite" });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("moved");
  await page.goto("/trips/yosemite/photos");
  await expect(page.getByRole("heading", { name: /2 photos/ })).toBeVisible();

  // Uploader names are a members-only layer.
  await page.goto("/collections/best-of-2025/photos");
  await page.locator("li button").first().click();
  await expect(page.getByText("Uploaded by a family member")).toBeVisible();
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto("/collections/best-of-2025/photos");
  await expect(anonPage.locator("img[src*='/api/photos/']").first()).toBeVisible();
  await anonPage.locator("li button").first().click();
  await expect(anonPage.getByRole("dialog")).toBeVisible();
  await expect(anonPage.getByText(/Uploaded by/)).toHaveCount(0);
  await anon.close();
});

test("a YouTube link becomes an embedded video with a stored poster and a click-to-play facade", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/trips/yosemite/photos");
  await page.getByRole("button", { name: "Add a YouTube video" }).click();
  await page.getByLabel("YouTube link").fill("https://youtu.be/dQw4w9WgXcQ?si=abc");
  await page.getByLabel("Date it was filmed").fill("2025-09-03");
  await page.getByRole("button", { name: "Add video" }).click();
  await expect(page.getByRole("status")).toContainText("Added Mock video dQw4w9WgXcQ");
  // The poster is made in the background and the gallery is server-rendered, so reload until it is there.
  const tile = page.locator("li", { hasText: "video" }).first();
  await expect
    .poll(async () => {
      await page.reload();
      return tile.locator("img[src*='/api/photos/']").count();
    }, { timeout: 30_000, intervals: [1000] })
    .toBe(1);
  await expect(page.getByRole("heading", { name: /3 photos/ })).toBeVisible();
  await tile.locator("button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Playing sends your request to YouTube")).toBeVisible();
  await expect(dialog.locator("iframe")).toHaveCount(0);
  await dialog.getByRole("button", { name: /^Play / }).click();
  await expect(dialog.locator("iframe")).toHaveAttribute("src", /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  const csp = (await context.request.get("/trips/yosemite/photos")).headers()["content-security-policy"];
  expect(csp).toContain("frame-src https://www.youtube-nocookie.com");

  // A link to a video that is gone is refused before anything is stored.
  await page.goto("/upload");
  await page.getByRole("button", { name: "Add a YouTube video" }).click();
  await page.getByLabel("YouTube link").fill("https://www.youtube.com/watch?v=gonegonegon");
  await page.getByRole("button", { name: "Add video" }).click();
  await expect(page.getByText("private, deleted, or cannot be embedded")).toBeVisible();
});

test("a short clip is transcoded with a poster and streams with range requests; a long one is refused before upload", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/upload?trip=yosemite");
  await chooseFile(page, "long-clip.mp4");
  await expect(page.getByText(/limited to 90 seconds/)).toBeVisible();
  await chooseFile(page, "clip.mp4");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 90_000 });
  // Headless Chromium cannot decode H.264, so the browser reports an unknown duration and the server is the authority:
  // the long clip must end FAILED with the message naming the YouTube route, the short one READY.
  const rows = await withDb((c) => c.query('SELECT id, status, error, "durationS" FROM "Photo" WHERE kind = $1 ORDER BY "createdAt"', ["VIDEO"]));
  expect(rows.rows.map((r) => r.status).sort()).toEqual(["FAILED", "READY"]);
  expect(rows.rows.find((r) => r.status === "FAILED")?.error).toContain("limited to 90 seconds");
  const row = { rows: rows.rows.filter((r) => r.status === "READY") };
  expect(Number(row.rows[0].durationS)).toBeGreaterThan(1.5);
  const videoUrl = `/api/photos/${row.rows[0].id}/video`;
  const partial = await context.request.get(videoUrl, { headers: { range: "bytes=0-99" } });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-range"]).toMatch(/^bytes 0-99\//);
  expect((await partial.body()).length).toBe(100);
  await page.goto("/trips/yosemite/photos");
  await page.locator("li", { hasText: "0:02" }).first().locator("button").click();
  await expect(page.getByRole("dialog").locator("video")).toHaveAttribute("src", /\/video\?v=/);
});
