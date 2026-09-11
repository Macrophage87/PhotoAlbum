import { expect, test, type Locator, type Page } from "@playwright/test";
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


/** Server-action buttons on a freshly reloaded page can lose a click before hydration; click until the database agrees. */
async function clickUntil(page: Page, button: () => Locator, done: () => Promise<boolean>) {
  await expect
    .poll(async () => {
      if (await done()) return true;
      await page.reload();
      await page.waitForLoadState("networkidle");
      const b = button();
      if (await b.count()) await b.first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(800);
      return done();
    }, { timeout: 40_000, intervals: [1500] })
    .toBe(true);
}

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
    await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Best of 2025")).toBeChecked();
  }
  await page.goto("/collections/best-of-2025/photos");
  await expect(page.getByRole("heading", { name: /2 items/ })).toBeVisible();

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
  await expect(page.getByRole("alert").getByText(/limited to 90 seconds/)).toBeVisible();
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

test("notes from the review screen and the item page are searchable, within what each viewer may see", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  const acadia = await withDb((c) => c.query('SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = $1', ["acadia"]));
  await page.goto(`/review?ids=${acadia.rows[0].id}`);
  await expect(page.getByRole("heading", { name: "Review this upload" })).toBeVisible();
  await page.getByLabel(/^Notes for/).fill("lobster rolls on the mail boat");
  await page.getByRole("button", { name: "Set note" }).click();
  await expect(page.getByRole("status")).toContainText("Set the note on 1 item");
  await page.getByRole("button", { name: /Mark all 1 reviewed/ }).click();
  await expect(page.getByRole("status")).toContainText("marked reviewed");

  await page.goto("/search?q=lobster");
  await expect(page.getByRole("status")).toContainText("1 result");
  await expect(page.getByText("Uploaded by a family member")).toBeVisible();
  await page.goto("/search?q=Mock+video");
  await expect(page.getByRole("status")).toContainText("1 result");

  // Anonymous: the Acadia photo is public through the collection; the YouTube video sits on a private trip.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto("/search?q=lobster");
  await expect(anonPage.getByRole("status")).toContainText("1 result");
  await expect(anonPage.getByText(/Uploaded by/)).toHaveCount(0);
  await expect(anonPage.getByLabel("Uploaded by")).toHaveCount(0);
  await anonPage.goto("/search?q=Mock+video");
  await expect(anonPage.getByRole("status")).toContainText("Nothing matches");
  await anon.close();
});

test("the AI helper describes reviewed items once an admin opts in, and opted-out trips are never sent", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/admin");
  await expect(page.getByText("nothing is sent")).toBeVisible();
  await page.getByRole("button", { name: "Turn on annotation" }).click();
  await expect(page.getByText("sending new items after review")).toBeVisible();

  // Opt the Yosemite trip out before anything is described, then review everything.
  await page.goto("/trips/yosemite/settings");
  await page.getByLabel("Never send to the AI helper").check();
  await expect(page.getByLabel("Never send to the AI helper")).toBeChecked();
  await page.goto("/review");
  await page.getByRole("button", { name: /Mark all \d+ reviewed/ }).click();
  // Once everything is reviewed the queue page re-renders empty.
  await expect(page.getByText("0 items nobody has reviewed yet.")).toBeVisible();

  // The Acadia photo (already reviewed earlier) is described on demand; the mock answers with the recorded record.
  const acadia = await withDb((c) => c.query('SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = $1', ["acadia"]));
  await page.goto(`/photos/${acadia.rows[0].id}`);
  await page.getByRole("button", { name: "Describe now" }).click();
  await expect
    .poll(async () => {
      await page.reload();
      return page.getByText("written by the AI helper").count();
    }, { timeout: 30_000, intervals: [1000] })
    .toBe(1);
  await expect(page.getByLabel("Caption", { exact: true }).nth(1)).toHaveValue("Lobster rolls on the mail boat");
  await page.goto("/search?q=seafood");
  await expect(page.getByRole("status")).toContainText("1 result");

  // Nothing on the opted-out trip was sent, even though it was reviewed.
  const yosemite = await withDb((c) => c.query('SELECT p."annotatedAt", p.annotation FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = $1', ["yosemite"]));
  expect(yosemite.rows.length).toBeGreaterThan(0);
  expect(yosemite.rows.every((r) => r.annotatedAt === null && r.annotation === null)).toBe(true);
  const yid = await withDb((c) => c.query('SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = $1 AND p.kind = $2 LIMIT 1', ["yosemite", "PHOTO"]));
  await page.goto(`/photos/${yid.rows[0].id}`);
  await expect(page.getByText("Not sent to the AI helper.")).toBeVisible();

  // Let Yosemite be described again, then a backfill over everything sends only what is eligible, through the (mock) Batches API.
  await page.goto("/trips/yosemite/settings");
  await page.getByLabel("Never send to the AI helper").uncheck();
  await expect(page.getByLabel("Never send to the AI helper")).not.toBeChecked();
  await page.goto("/admin");
  await page.getByRole("button", { name: "Estimate" }).click();
  const status = page.getByRole("status").first();
  await expect(status).toContainText("would be sent");
  const count = Number((await status.textContent())!.match(/(\d+) items? would be sent/)![1]);
  expect(count).toBeGreaterThan(0);
  await page.getByLabel(`Type ${count} to confirm`).fill(String(count));
  await page.getByRole("button", { name: "Send to the helper" }).click();
  await expect(page.getByText("Backfill submitted")).toBeVisible();
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT status, succeeded FROM "AnnotationBatch" ORDER BY "createdAt" DESC LIMIT 1'))).rows[0], { timeout: 45_000, intervals: [1500] })
    .toMatchObject({ status: "ENDED", succeeded: count });
  const described = await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = $1 AND p."annotatedAt" IS NOT NULL', ["yosemite"]));
  expect(described.rows[0].n).toBe(count);
});

test("uploads get embeddings from the sidecar and the review screen suggests where they belong", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // A photo taken on 12 August 2025 near Bar Harbor, left without a trip: Acadia (10–16 Aug) should be suggested.
  await page.goto("/upload");
  await chooseFile(page, "photo-with-gps.jpg");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  const fresh = await withDb((c) => c.query('SELECT id FROM "Photo" WHERE "originalName" = $1 ORDER BY "createdAt" DESC LIMIT 1', ["photo-with-gps.jpg"]));
  const id = fresh.rows[0].id as string;
  // The photo matched Acadia by date; move it off so the suggestion has something to suggest.
  await withDb((c) => c.query('UPDATE "Photo" SET "tripId" = NULL WHERE id = $1', [id]));
  await page.goto(`/review?ids=${id}`);
  const suggestion = page.getByRole("button", { name: /Add to trip Acadia/ }).first();
  // Background jobs on a fresh upload can still be writing; the suggestion appears once the row settles.
  await expect.poll(async () => { await page.reload(); return suggestion.count(); }, { timeout: 20_000, intervals: [1000] }).toBe(1);
  await page.waitForLoadState("networkidle");
  await expect(suggestion).toContainText("taken during the trip");
  await suggestion.click();
  // The server re-renders without the suggestion once the item is filed, so check the outcome itself.
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT t.slug FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE p.id = $1', [id]))).rows[0]?.slug, { timeout: 15_000, intervals: [500] })
    .toBe("acadia");
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT ("embedding" IS NOT NULL) AS e FROM "Photo" WHERE id = $1', [id]))).rows[0].e, { timeout: 30_000, intervals: [1000] })
    .toBe(true);
});

test("faces are found once an admin opts in, named with consent recorded, shown to members only, and forgotten on request", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/admin");
  await expect(page.getByText("not scanning")).toBeVisible();
  await page.getByRole("button", { name: "Turn on face detection" }).click();
  await expect(page.getByText("scanning new photos")).toBeVisible();

  // The sweep only runs every few minutes; a fresh upload is scanned right away.
  await page.goto("/upload");
  await chooseFile(page, "photo-with-gps.jpg");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face"'))).rows[0].n, { timeout: 30_000, intervals: [1000] })
    .toBeGreaterThan(0);

  await page.goto("/people");
  await expect(page.getByText(/face(s)? that look alike/).first()).toBeVisible();
  const form = page.locator("form").filter({ hasText: "Name these faces" }).first();
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Grandma Jo");
  await form.getByRole("textbox", { name: "Birthday" }).fill("1946-03-02");
  await form.getByRole("checkbox", { name: /Recognise this person/ }).check();
  await form.getByRole("button", { name: "Name these faces" }).click();
  await expect(page.getByRole("link", { name: /Grandma Jo/ })).toBeVisible();
  await expect(page.getByText("recognised · by birthday")).toBeVisible();
  const person = await withDb((c) => c.query('SELECT id, "faceIndexing", "faceIndexingSetById" FROM "Person" WHERE name = $1', ["Grandma Jo"]));
  expect(person.rows[0].faceIndexing).toBe(true);
  expect(person.rows[0].faceIndexingSetById).toBeTruthy();
  const kept = await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face" WHERE "personId" = $1 AND embedding IS NOT NULL', [person.rows[0].id]));
  expect(kept.rows[0].n).toBeGreaterThan(0);

  // Members see the name; anonymous visitors never do, even on a public collection.
  await page.goto(`/people/${person.rows[0].id}`);
  await expect(page.getByRole("heading", { name: "Grandma Jo" })).toBeVisible();
  await page.goto("/search?q=Grandma");
  await expect(page.getByRole("status")).toContainText(/\d+ result/);
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/people/${person.rows[0].id}`);
  await expect(anonPage).toHaveURL(/\/auth\/signin/);
  await anonPage.goto("/search?q=Grandma");
  await expect(anonPage.getByRole("status")).toContainText("Nothing matches");
  await anon.close();

  // Forgetting deletes the templates and the appearance record.
  await page.goto(`/people/${person.rows[0].id}`);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Forget face data" }).click();
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face" WHERE "personId" = $1', [person.rows[0].id]))).rows[0].n, { timeout: 15_000 })
    .toBe(0);
  const clusters = await withDb((c) => c.query('SELECT count(*)::int AS n FROM "FaceCluster" WHERE "personId" = $1', [person.rows[0].id]));
  expect(clusters.rows[0].n).toBe(0);
});

test("a consented person is proposed on the next upload, names in the notes propose people and pets, and pets are tagged from the lightbox", async ({ page, context }) => {
  await signIn(context, ADMIN);
  await page.goto("/admin");
  await expect(page.getByText(/scanning new photos|not scanning/)).toBeVisible();
  if (await page.getByRole("button", { name: "Turn on face detection" }).isVisible()) await page.getByRole("button", { name: "Turn on face detection" }).click();
  await expect(page.getByText("scanning new photos")).toBeVisible();

  // Name the first face as a consented adult.
  await page.goto("/upload");
  await chooseFile(page, "photo-with-gps.jpg");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face" WHERE status = $1', ["DETECTED"]))).rows[0].n, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.goto("/people");
  const form = page.locator("form").filter({ hasText: "Name these faces" }).first();
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Uncle Dan");
  await form.getByRole("textbox", { name: "Birthday" }).fill("1970-01-15");
  await form.getByRole("checkbox", { name: /Recognise this person/ }).check();
  await form.getByRole("button", { name: "Name these faces" }).click();
  await expect(page.getByRole("link", { name: /Uncle Dan/ })).toBeVisible();

  // The mock sidecar returns the same face for the same bytes, so the next upload of that image is a match.
  await page.goto("/upload");
  await chooseFile(page, "photo-with-gps.jpg");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  const ids = await page.getByRole("link", { name: /Add notes and file/ }).getAttribute("href");
  await page.goto(ids!);
  await expect.poll(async () => { await page.reload(); return page.getByText(/Probably/).count(); }, { timeout: 30_000, intervals: [1500] }).toBeGreaterThan(0);
  await expect(page.getByTestId("proposal").first()).toContainText("Uncle Dan");
  const danConfirmed = async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face" f JOIN "Person" p ON p.id = f."personId" WHERE p.name = $1 AND f.status = $2', ["Uncle Dan", "CONFIRMED"]))).rows[0].n === 2;
  await clickUntil(page, () => page.getByRole("button", { name: /Yes, that's Uncle/ }), danConfirmed);
  await page.reload();
  await expect(page.getByTestId("proposal")).toHaveCount(0);
  const eras = await withDb((c) => c.query('SELECT "ageBandMin", "ageBandMax" FROM "FaceCluster" fc JOIN "Person" p ON p.id = fc."personId" WHERE p.name = $1', ["Uncle Dan"]));
  expect(eras.rows.length).toBe(1);

  // Pets: add one, then a note naming it proposes it; tag another from the lightbox; search finds both.
  await page.goto("/people");
  const petForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Add pet" }) });
  await petForm.locator("#pet-name").fill("Biscuit");
  await petForm.locator("#pet-species").selectOption("DOG");
  await petForm.getByRole("button", { name: "Add pet" }).click();
  await expect(page.getByRole("link", { name: /Biscuit/ })).toBeVisible();
  await page.goto("/upload");
  await chooseFile(page, "photo-no-gps.jpg");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  const ids2 = await page.getByRole("link", { name: /Add notes and file/ }).getAttribute("href");
  await page.goto(ids2!);
  await page.getByLabel(/Notes for/).fill("Biscuit asleep on the porch");
  await page.getByRole("button", { name: "Set note" }).click();
  await expect.poll(async () => { await page.reload(); return page.getByText(/Probably Biscuit/).count(); }, { timeout: 30_000, intervals: [1500] }).toBe(1);
  const biscuitConfirmed = async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face" f JOIN "Person" p ON p.id = f."personId" WHERE p.name = $1 AND f.status = $2', ["Biscuit", "CONFIRMED"]))).rows[0].n === 1;
  await clickUntil(page, () => page.getByRole("button", { name: /Yes, that's Biscuit/ }), biscuitConfirmed);
  // The two fixture images have the same pixels, so Dan is proposed here too; saying no records a negative example.
  const danRow = page.getByTestId("proposal").filter({ hasText: "Uncle Dan" });
  await expect.poll(async () => { await page.reload(); return danRow.count(); }, { timeout: 30_000, intervals: [1500] }).toBe(1);
  const danRejected = async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face" f JOIN "Person" p ON p.id = f."proposedPersonId" WHERE p.name = $1 AND f.status = $2', ["Uncle Dan", "REJECTED"]))).rows[0].n === 1;
  await clickUntil(page, () => danRow.getByRole("button", { name: "No" }), danRejected);
  await page.reload();
  await expect(page.getByTestId("proposal")).toHaveCount(0);

  // Open a photo with no pet tag yet in the lightbox, wherever it was filed (a trip by date, or the unassigned page).
  const target = await withDb((c) => c.query(`SELECT p.id, t.slug FROM "Photo" p LEFT JOIN "Trip" t ON t.id = p."tripId" WHERE p.status = 'READY' AND p.kind = 'PHOTO' AND NOT EXISTS (SELECT 1 FROM "Face" f WHERE f."photoId" = p.id AND f.confidence = 0) ORDER BY p."createdAt" DESC LIMIT 1`));
  await page.goto(target.rows[0].slug ? `/trips/${target.rows[0].slug}/photos` : "/photos");
  await page.locator(`button:has(img[src*='/api/photos/${target.rows[0].id}/'])`).first().click();
  const dialog = page.getByRole("dialog", { name: "Photo viewer" });
  await dialog.getByRole("button", { name: "Tag a pet" }).click();
  await dialog.getByLabel("Pet").selectOption({ label: "Biscuit" });
  await dialog.getByRole("button", { name: "Tag", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Tag a pet" })).toBeVisible();
  await page.keyboard.press("Escape");
  const tags = await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face" f JOIN "Person" p ON p.id = f."personId" WHERE p.name = $1 AND f.status = $2', ["Biscuit", "CONFIRMED"]));
  expect(tags.rows[0].n).toBe(2);
  await page.goto("/search?q=Biscuit");
  await expect(page.getByRole("status")).toContainText(/2 results/);
});

test("the similarity graph and the similar-photos strip are members-only and show look-alike items", async ({ page, context, request }) => {
  // Two uploads of the same image (from the people test) share an embedding, so they are neighbours at score 1.
  const anon = await request.get("/api/graph");
  expect(anon.status()).toBe(401);
  await signIn(context, ADMIN);
  await expect.poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "MediaSimilarity"'))).rows[0].n, { timeout: 30_000 }).toBeGreaterThan(0);
  const pair = await withDb((c) => c.query('SELECT "photoAId" FROM "MediaSimilarity" ORDER BY score DESC LIMIT 1'));
  await page.goto(`/photos/${pair.rows[0].photoAId}`);
  await expect(page.getByTestId("similar-strip").locator("img").first()).toBeVisible();
  await page.goto("/graph");
  await expect(page.getByRole("status")).toContainText(/\d+ items · [1-9]\d* links/);
  await expect(page.getByTestId("graph-canvas").locator("canvas").first()).toBeVisible();
  // Pages carry a per-request nonce policy; the API keeps the frame-only one.
  const res = await request.get("/graph");
  expect(res.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
});

test("a Google Takeout archive in the inbox imports with dates, places, notes and a private album, then can be deleted", async ({ context, page }) => {
  const inbox = process.env.E2E_INBOX_DIR ?? "/tmp/photoalbum-e2e-inbox";
  const { copyFileSync, existsSync } = await import("node:fs");
  copyFileSync(fixture("takeout.zip"), path.join(inbox, "takeout-e2e.zip"));
  await signIn(context, ADMIN);
  await page.goto("/admin");
  const row = page.getByTestId("takeout-admin").getByText("takeout-e2e.zip").locator("..").locator("..");
  await page.waitForLoadState("networkidle");
  await row.getByRole("button", { name: "Import" }).click();
  await expect.poll(async () => (await withDb((c) => c.query('SELECT status FROM "TakeoutImport" WHERE "archiveName" = $1', ["takeout-e2e.zip"]))).rows[0]?.status, { timeout: 60_000 }).toBe("ENDED");
  const run = await withDb((c) => c.query('SELECT imported, skipped, "collectionsCreated" FROM "TakeoutImport" WHERE "archiveName" = $1', ["takeout-e2e.zip"]));
  expect(run.rows[0]).toMatchObject({ imported: 4, skipped: 1, collectionsCreated: 1 });
  // Every imported item goes through the normal pipeline and keeps its sidecar date and place.
  await expect.poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" WHERE "sourceKind" = 'TAKEOUT' AND status = 'READY'`))).rows[0].n, { timeout: 90_000 }).toBe(4);
  const gps = await withDb((c) => c.query(`SELECT "takenAtSource", "gpsSource", lat, context, "contentHash" FROM "Photo" WHERE "originalName" = 'photo-with-gps.jpg' AND "sourceKind" = 'TAKEOUT'`));
  expect(gps.rows[0]).toMatchObject({ takenAtSource: "SIDECAR", gpsSource: "EXIF", context: "Otter Cliff from the Ocean Path" });
  expect(gps.rows[0].contentHash).toHaveLength(64);
  const album = await withDb((c) => c.query(`SELECT visibility, "shareToken" FROM "Collection" WHERE title = 'Lake House'`));
  expect(album.rows[0]).toEqual({ visibility: "PRIVATE", shareToken: null });
  await page.reload();
  await expect(page.getByTestId("takeout-import").first()).toHaveAttribute("data-status", "ENDED");
  await expect(page.getByTestId("takeout-import").first()).toContainText("4 imported");
  page.once("dialog", (d) => d.accept());
  await page.waitForLoadState("networkidle");
  await page.getByTestId("takeout-admin").getByText("takeout-e2e.zip").locator("..").locator("..").getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => existsSync(path.join(inbox, "takeout-e2e.zip")), { timeout: 15_000 }).toBe(false);
});

test("a member connects Google Photos, picks items on Google's page, gets them on the review screen, and can disconnect", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/upload");
  await page.getByRole("link", { name: "Connect Google Photos" }).click();
  await page.waitForURL("**/upload?google=connected");
  const picker = page.getByTestId("google-picker");
  await expect(picker.getByRole("button", { name: "Pick from Google Photos" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await picker.getByRole("button", { name: "Pick from Google Photos" }).click();
  const [popup] = await Promise.all([context.waitForEvent("page"), picker.getByRole("link", { name: "Open Google Photos" }).click()]);
  await expect(popup.getByText("Mock Google Photos picker")).toBeVisible();
  await popup.close();
  await expect(picker.getByRole("status")).toContainText("Copying 3 items", { timeout: 30_000 });
  await page.waitForURL(/\/review\?ids=.*google=1/, { timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "Review what you picked" })).toBeVisible();
  await expect(page.getByText("Google leaves the location out")).toBeVisible();
  const rows = await withDb((c) => c.query(`SELECT "sourceId", status, kind, "originalName" FROM "Photo" WHERE "sourceKind" = 'GOOGLE_PICKER' ORDER BY "sourceId"`));
  expect(rows.rows).toEqual([
    { sourceId: "gp-item-1", status: "READY", kind: "PHOTO", originalName: "photo-with-gps.jpg" },
    { sourceId: "gp-item-2", status: "READY", kind: "PHOTO", originalName: "IMG_2001.jpg" },
    { sourceId: "gp-item-3", status: "READY", kind: "VIDEO", originalName: "clip.mp4" },
  ]);
  // Picking the same items again imports nothing.
  await page.goto("/upload");
  await page.waitForLoadState("networkidle");
  await picker.getByRole("button", { name: "Pick from Google Photos" }).click();
  const [popup2] = await Promise.all([context.waitForEvent("page"), picker.getByRole("link", { name: "Open Google Photos" }).click()]);
  await popup2.close();
  await expect(picker.getByRole("alert")).toContainText("already in the album", { timeout: 30_000 });
  expect((await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" WHERE "sourceKind" = 'GOOGLE_PICKER'`))).rows[0].n).toBe(3);
  // The connection is one encrypted token, gone on disconnect.
  const stored = await withDb((c) => c.query('SELECT "encryptedRefreshToken" FROM "GoogleAccount"'));
  expect(stored.rows[0].encryptedRefreshToken).toMatch(/^v1\./);
  expect(stored.rows[0].encryptedRefreshToken).not.toContain("mock-refresh");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await picker.getByRole("button", { name: "Disconnect Google" }).click();
  await expect(picker.getByRole("link", { name: "Connect Google Photos" })).toBeVisible();
  expect((await withDb((c) => c.query('SELECT count(*)::int AS n FROM "GoogleAccount"'))).rows[0].n).toBe(0);
});

test("a pet tagged on a spotted animal is proposed on the next look-alike and confirmed from the review screen", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/admin");
  await expect(page.getByTestId("pet-gates")).toContainText("on,");
  await page.goto("/people");
  const petForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Add pet" }) });
  await petForm.locator("#pet-name").fill("Rex");
  await petForm.locator("#pet-species").selectOption("DOG");
  await petForm.locator("#pet-descriptors").fill("black lab");
  await petForm.getByRole("button", { name: "Add pet" }).click();
  await expect(page.getByRole("link", { name: /Rex/ })).toBeVisible();
  // First sighting: upload, wait for the sidecar to spot the animal, tag Rex by hand from the lightbox.
  await page.goto("/upload");
  await chooseFile(page, "clip-poster.jpg");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  const first = await withDb((c) => c.query(`SELECT p.id, t.slug FROM "Photo" p LEFT JOIN "Trip" t ON t.id = p."tripId" WHERE p."originalName" = 'clip-poster.jpg' ORDER BY p."createdAt" DESC LIMIT 1`));
  await expect.poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "AnimalDetection" WHERE "photoId" = $1', [first.rows[0].id]))).rows[0].n, { timeout: 30_000 }).toBe(1);
  await page.goto(first.rows[0].slug ? `/trips/${first.rows[0].slug}/photos` : "/photos");
  await page.locator(`button:has(img[src*='/api/photos/${first.rows[0].id}/'])`).first().click();
  const dialog = page.getByRole("dialog", { name: "Photo viewer" });
  await dialog.getByRole("button", { name: "Tag a pet" }).click();
  await dialog.getByLabel("Pet").selectOption({ label: "Rex" });
  await dialog.getByRole("button", { name: "Tag", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Tag a pet" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "AnimalDetection" a JOIN "Person" p ON p.id = a."personId" WHERE p.name = 'Rex' AND a.status = 'CONFIRMED'`))).rows[0].n).toBe(1);
  // Same bytes again: the mock sidecar returns the same crop embedding, so Rex is proposed.
  await page.goto("/upload");
  await chooseFile(page, "clip-poster.jpg");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
  const ids = await page.getByRole("link", { name: /Add notes and file/ }).getAttribute("href");
  await page.goto(ids!);
  const rexRow = page.getByTestId("proposal").filter({ hasText: "Rex" });
  await expect.poll(async () => { await page.reload(); return rexRow.count(); }, { timeout: 30_000, intervals: [1500] }).toBe(1);
  await expect(rexRow).toContainText("a dog spotted in");
  const rexConfirmed = async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Face" f JOIN "Person" p ON p.id = f."personId" WHERE p.name = 'Rex' AND f.status = 'CONFIRMED'`))).rows[0].n === 2;
  await clickUntil(page, () => rexRow.getByRole("button", { name: /Yes, that's Rex/ }), rexConfirmed);
  const rex = await withDb((c) => c.query(`SELECT id FROM "Person" WHERE name = 'Rex'`));
  await page.goto(`/people/${rex.rows[0].id}`);
  await expect(page.getByText(/black lab · 2 photos/)).toBeVisible();
});
