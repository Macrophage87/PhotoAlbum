import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { stillIsBlank } from "@/lib/images/poster";
import { createTrip, resetDb, setVisibility, signIn, withDb } from "./helpers";

// Must match ADMIN_EMAIL as set by scripts/e2e-server.mjs: only that address may bootstrap the admin account.
const ADMIN = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.com";
const fixture = (n: string) => path.join(__dirname, "../fixtures", n);

/**
 * Pick a file only once the page has hydrated, otherwise React's change handler is not attached yet and nothing
 * uploads. The photo uploader offers two ways in — the phone's own storage first, then the photo library — so take
 * the first input rather than insisting there is only one. The track importer's page has just the one.
 *
 * Each pick sends bytes of its own. The album refuses a file it already holds, byte for byte, and these tests send
 * the same handful of fixtures over and over while meaning a different photograph each time; a few bytes after a
 * JPEG's end marker, which every decoder ignores, keep that pretence honest. Tests about duplicates send the same
 * bytes deliberately — see `chooseSameFile`.
 */
async function chooseFile(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  const input = page.locator('input[type="file"]').first();
  if (/\.(jpe?g|png)$/i.test(name)) {
    const buffer = Buffer.concat([fs.readFileSync(fixture(name)), Buffer.from(`\n<!-- ${randomUUID()} -->`)]);
    await input.setInputFiles({ name, mimeType: name.endsWith(".png") ? "image/png" : "image/jpeg", buffer });
    return;
  }
  await input.setInputFiles(fixture(name));
}

/** The very same bytes every time, for the tests that are about the album noticing exactly that. */
async function chooseSameFile(page: Page, name: string, buffer: Buffer) {
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "image/jpeg", buffer });
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
  const row = await withDb((c) => c.query('SELECT id, status, "takenAtSource", lat FROM "Photo" LIMIT 1'));
  expect(row.rows[0]).toMatchObject({ status: "READY", takenAtSource: "EXIF_OFFSET" });
  // A place can be set by hand: look a spot up, take the hit, save; the position is marked as set by a member.
  await page.goto(`/photos/${row.rows[0].id}`);
  await page.waitForLoadState("networkidle");
  const place = page.getByTestId("place-editor");
  await place.getByRole("button", { name: /Change place|Set a place/ }).click();
  await place.getByLabel("Look up a place").fill("Jordan Pond");
  await place.getByRole("button", { name: "Look up" }).click();
  await place.getByRole("button", { name: /Jordan Pond, Mount Desert Island/ }).click();
  await place.getByRole("button", { name: "Save place" }).click();
  // The label names whoever pinned it, falling back to the part of their address before the @.
  await expect(place.getByText("set by e2e-admin")).toBeVisible();
  // What was looked up is what the place is called: the coordinates are shown under the name, not instead of it.
  await expect(place.getByTestId("place-name")).toHaveText(/Jordan Pond/);
  await expect(place.getByText("44.32600, -68.25300")).toBeVisible();
  const placed = await withDb((c) => c.query('SELECT lat, lng, "gpsSource", "placeName" FROM "Photo" WHERE id = $1', [row.rows[0].id]));
  expect(placed.rows[0]).toMatchObject({ lat: 44.326, lng: -68.253, gpsSource: "MANUAL" });
  expect(placed.rows[0].placeName).toMatch(/Jordan Pond/);
  expect(Number(row.rows[0].lat)).toBeCloseTo(44.35, 3);
});

test("the pickers search rather than listing every trip and collection", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  // The lookup answers a shortlist, by name, and only for members.
  const all = await page.request.get("/api/containers?kind=trip");
  expect(all.ok()).toBe(true);
  const { hits } = (await all.json()) as { hits: { title: string; slug: string }[] };
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.length).toBeLessThanOrEqual(20);
  const narrowed = await page.request.get("/api/containers?kind=trip&q=acad");
  expect(((await narrowed.json()) as { hits: { slug: string }[] }).hits.map((h) => h.slug)).toEqual(["acadia"]);
  const nothing = await page.request.get("/api/containers?kind=trip&q=zzzznotatrip");
  expect(((await nothing.json()) as { hits: unknown[] }).hits).toHaveLength(0);

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  expect((await anonPage.request.get("/api/containers?kind=trip")).status()).toBe(401);
  await anon.close();

  // The front page finds a trip by name rather than asking anyone to scroll for it.
  await page.goto("/");
  await page.getByLabel("Find a trip or collection by name").fill("Acadia");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByRole("link", { name: /Acadia/ }).first()).toBeVisible();
  await expect(page.getByText(/1 trip matching/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Yosemite/ })).toHaveCount(0);
});

test("the map across everything shows a photo that is on no trip", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // A placed photo filed under no trip: it used to be missing from the map across everything, while a trip's own map
  // and a collection's map both showed their photos perfectly well.
  const loose = await withDb((c) => c.query(
    `INSERT INTO "Photo" (id, "uploaderId", "originalName", "mimeType", "storageKey", "originalPath", "sizeBytes", status, lat, lng, "gpsSource", "updatedAt", "createdAt")
     SELECT 'e2eloosephoto', id, 'loose.jpg', 'image/jpeg', 'k', 'k/o.jpg', 1, 'READY', 41.9022, 12.4568, 'MANUAL', now(), now() FROM "User" WHERE email = $1 RETURNING id`,
    [ADMIN],
  ));
  expect(loose.rows).toHaveLength(1);
  const payload = await page.request.get("/api/map/geojson");
  expect(payload.ok()).toBe(true);
  const body = await payload.json();
  expect(body.photos.features.map((f: { properties: { id: string } }) => f.properties.id)).toContain("e2eloosephoto");
  await withDb((c) => c.query(`DELETE FROM "Photo" WHERE id = 'e2eloosephoto'`));
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
  // Sharing starts with the link itself, ready to copy; Facebook is beside it rather than instead of it.
  await page.getByTestId("share-open").click();
  await expect(page.getByTestId("copy-link").getByRole("textbox")).toHaveValue(/\/share\/e2e-share-token/);
  await expect(page.getByTestId("share-facebook")).toHaveAttribute("href", /%2Fshare%2Fe2e-share-token/);
  // Link previews fetch the cover without a cookie, so the og:image URL must work on its own.
  //
  // Read from the HTML the server sends rather than from the page's own head. A crawler never runs the page, so
  // that HTML is the thing under test; the head briefly holds two copies of each tag while React hydrates, which
  // is invisible to a preview but enough to make a strict locator throw on a slow machine.
  const served = await page.request.get("/share/e2e-share-token/photos");
  const html = await served.text();
  const ogImages = [...html.matchAll(/<meta property="og:image" content="([^"]*)"/g)].map((m) => m[1]);
  expect(ogImages).toHaveLength(1);
  const ogImage = ogImages[0]!.replace(/&amp;/g, "&");
  expect(ogImage).toContain("share=e2e-share-token");
  const crawler = await browser.newContext();
  const bare = await crawler.request.get(ogImage!);
  expect(bare.ok()).toBe(true);
  // And it arrives as JPEG. Everything the album stores is WebP, which Facebook, Messenger and WhatsApp draw as
  // nothing at all — a card with no picture, which is what the family reads as the link being broken.
  expect(ogImage).toContain("/preview?");
  expect(bare.headers()["content-type"]).toBe("image/jpeg");
  await crawler.close();
  await setVisibility("acadia", "LINK", "rotated-token");
  await page.goto("/share/e2e-share-token");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await anon.close();
});

test("public trips are browsable anonymously without edit controls", async ({ browser }) => {
  await setVisibility("acadia", "PUBLIC");
  // Copying needs the clipboard, and a browser hands that over only to a page it has given permission and that is
  // in front. Neither is the album's business — it falls back to selecting the text — but the test is about the
  // copy actually happening, so it asks for the conditions the copy needs.
  const anon = await browser.newContext({ permissions: ["clipboard-write"] });
  const page = await anon.newPage();
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Acadia/ })).toBeVisible();
  await page.goto("/trips/acadia");
  await expect(page.getByRole("heading", { name: "Acadia" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Family sign in" })).toBeVisible();
  await page.getByTestId("share-open").click();
  const shareField = page.getByTestId("copy-link").getByRole("textbox");
  await expect(shareField).toHaveValue(/\/trips\/acadia$/);
  await page.bringToFront();
  await page.getByTestId("copy-link-button").click();
  await expect(page.getByTestId("copy-link-button")).toHaveText("Copied");
  await expect(page.getByTestId("share-facebook")).toHaveAttribute("href", /facebook\.com\/sharer\/sharer\.php\?u=.*%2Ftrips%2Facadia/);
  // What a link brings with it: the title, a line about the trip, and a cover big enough to be drawn large.
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Acadia");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/api\/photos\//);
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute("content", /\d+/);
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute("content", /\d+/);
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", /\w/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.goto("/trips/acadia/settings");
  await expect(page).toHaveURL(/\/auth\/signin/);
  await setVisibility("acadia", "PRIVATE");
  await page.goto("/trips/acadia");
  await expect(page).toHaveURL(/\/auth\/signin/);
  await anon.close();
});

test("one activity can be sent on its own link, which opens it and nothing else of the trip", async ({ browser, context, page }) => {
  await setVisibility("acadia", "PRIVATE");
  await signIn(context, ADMIN);
  const act = await withDb((c) => c.query(`SELECT id, title FROM "Activity" WHERE title = 'Ocean Path loop' LIMIT 1`));
  const activityId = act.rows[0].id as string;
  // Put a photograph on the walk, since the point of the link is that its own photographs come with it. Nothing
  // else in the suite has filed one here yet, and it is taken off again below so the trip is left as it was found.
  const mine = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p.status = 'READY' AND p."trashedAt" IS NULL AND p."activityId" IS NULL ORDER BY p.id LIMIT 1`));
  const photoId = mine.rows[0].id as string;
  await withDb((c) => c.query(`UPDATE "Photo" SET "activityId" = $2 WHERE id = $1`, [photoId, activityId]));

  // Make the link from the activity's own page.
  await page.goto(`/trips/acadia/activities/${activityId}`);
  await page.getByTestId("activity-share-on").click();
  await expect(page.getByTestId("activity-shared")).toBeVisible();
  await page.getByTestId("share-open").click();
  const link = await page.getByTestId("copy-link").getByRole("textbox").inputValue();
  expect(link).toMatch(/\/share\/a\/[A-Za-z0-9_-]+$/);
  const token = link.split("/share/a/")[1];

  // A stranger with the link sees the walk, its photographs and its stats.
  const anon = await browser.newContext();
  const guest = await anon.newPage();
  await guest.goto(`/share/a/${token}`);
  await expect(guest.getByText("Shared with you")).toBeVisible();
  await expect(guest.getByRole("heading", { name: "Ocean Path loop" })).toBeVisible();
  const img = guest.locator("img[src*='/api/photos/']").first();
  await expect(img).toBeVisible();
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  await withDb((c) => c.query(`UPDATE "Photo" SET "activityId" = NULL WHERE id = $1`, [photoId]));

  // And nothing else of the trip: the trip is private and stays private to them.
  await guest.goto("/trips/acadia");
  await expect(guest).toHaveURL(/\/auth\/signin/);
  await guest.goto("/trips/acadia/photos");
  await expect(guest).toHaveURL(/\/auth\/signin/);

  // A new link retires the old one.
  await page.goto(`/trips/acadia/activities/${activityId}`);
  await page.getByTestId("activity-share-rotate").click();
  await expect(page.getByTestId("activity-shared")).toBeVisible();
  const stale = await anon.newPage();
  await stale.goto(`/share/a/${token}`);
  await expect(stale.getByRole("heading", { name: "Ocean Path loop" })).toHaveCount(0);

  // And stopping sharing closes it altogether.
  const fresh = (await withDb((c) => c.query(`SELECT "shareToken" FROM "Activity" WHERE id = $1`, [activityId]))).rows[0].shareToken as string;
  await page.getByTestId("activity-share-off").click();
  await expect(page.getByTestId("activity-share-on")).toBeVisible();
  const gone = await anon.newPage();
  await gone.goto(`/share/a/${fresh}`);
  await expect(gone.getByRole("heading", { name: "Ocean Path loop" })).toHaveCount(0);
  await anon.close();
});

test("the helper writes an activity's description from its own photographs, and it travels with the link", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  const act = await withDb((c) => c.query(`SELECT id FROM "Activity" WHERE title = 'Ocean Path loop' LIMIT 1`));
  const activityId = act.rows[0].id as string;
  const mine = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p.status = 'READY' AND p."trashedAt" IS NULL AND p."activityId" IS NULL ORDER BY p.id LIMIT 1`));
  const onIt = mine.rows[0].id as string;
  await withDb((c) => c.query(`UPDATE "Photo" SET "activityId" = $2 WHERE id = $1`, [onIt, activityId]));
  await withDb((c) => c.query(`UPDATE "Activity" SET description = NULL WHERE id = $1`, [activityId]));
  // The helper is offered only once an admin has opted in on the disclosure screen. That opt-in has its own test,
  // further down this file; here it is switched on directly and put back before leaving, so the order of the file
  // does not decide whether this button exists.
  await withDb((c) => c.query(`INSERT INTO "AppSetting" (id, "annotationOptInAt", "updatedAt") VALUES ('app', now(), now()) ON CONFLICT (id) DO UPDATE SET "annotationOptInAt" = now()`));

  await page.goto(`/trips/acadia/activities/${activityId}`);
  await page.getByTestId("activity-description-edit").click();
  // What the family types is a note for the helper, not a description to keep: it goes with the photographs.
  await page.getByTestId("activity-description-text").fill("It was Dad's birthday and we turned back at the fog.");
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("activity-describe").click();
  // What comes back lands in the box, so it can be edited before it is kept.
  await expect(page.getByTestId("activity-description-text")).toHaveValue(/shore path/);
  await page.getByTestId("activity-description-save").click();
  await expect(page.getByTestId("activity-description")).toContainText(/shore path/);
  // It is the activity's own record, not a photograph's.
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT description FROM "Activity" WHERE id = $1`, [activityId]))).rows[0].description, { timeout: 15_000 })
    .toMatch(/shore path/);

  // What the helper wrote is a draft, not a verdict: it can be edited afterwards and the edit stands.
  await page.getByTestId("activity-description-edit").click();
  await page.getByTestId("activity-description-text").fill("We walked the shore path, and then we had chips.");
  await page.getByTestId("activity-description-save").click();
  await expect(page.getByTestId("activity-description")).toContainText("and then we had chips");

  // Whoever holds the activity's link reads it too. Wait for the page to show the link before reading it out of
  // the database: pressing the button starts a server action, and asking Postgres the instant after the click can
  // beat the write to it, which reads as a share that produced no token at all.
  await page.getByTestId("activity-share-on").click();
  await expect(page.getByTestId("activity-shared")).toBeVisible();
  const token = (await withDb((c) => c.query(`SELECT "shareToken" FROM "Activity" WHERE id = $1`, [activityId]))).rows[0].shareToken as string;
  expect(token).toBeTruthy();
  const anon = await browser.newContext();
  const guest = await anon.newPage();
  await guest.goto(`/share/a/${token}`);
  await expect(guest.getByTestId("activity-description")).toContainText(/shore path/);
  // And a stranger is never offered the button that spends money.
  await expect(guest.getByTestId("activity-describe")).toHaveCount(0);
  await anon.close();

  await withDb((c) => c.query(`UPDATE "Photo" SET "activityId" = NULL WHERE id = $1`, [onIt]));
  await withDb((c) => c.query(`UPDATE "Activity" SET "shareToken" = NULL WHERE id = $1`, [activityId]));
  await withDb((c) => c.query(`UPDATE "AppSetting" SET "annotationOptInAt" = NULL WHERE id = 'app'`));
});

test("a trip can say who was on it, and stops collecting everybody else's photographs", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  const other = "e2e-outsider@example.com";

  // Nobody named yet: the album files by date alone, so somebody who was never in Maine collects the trip anyway.
  const outside = await browser.newContext();
  await signIn(outside, other);
  const theirs = await outside.newPage();
  await theirs.goto("/upload");
  await chooseFile(theirs, "photo-with-gps.jpg");
  await expect(theirs.getByText("1 of 1 uploaded.")).toBeVisible({ timeout: 30_000 });
  const swept = await withDb((c) => c.query(`SELECT p.id, t.slug FROM "Photo" p LEFT JOIN "Trip" t ON t.id = p."tripId" JOIN "User" u ON u.id = p."uploaderId" WHERE u.email = $1 ORDER BY p."createdAt" DESC LIMIT 1`, [other]));
  expect(swept.rows[0].slug).toBe("acadia");
  await withDb((c) => c.query(`UPDATE "Photo" SET "trashedAt" = now() WHERE id = $1`, [swept.rows[0].id]));

  // Say who was on the trip: the admin, and not them.
  await page.goto("/trips/acadia/settings");
  await page.getByTestId("trip-who-open").click();
  await page.getByTestId("trip-who").getByLabel("e2e-admin@example.com").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/saved=1/);
  const named = await withDb((c) => c.query(`SELECT u.email FROM "_TripParticipants" tp JOIN "User" u ON u.id = tp."B" JOIN "Trip" t ON t.id = tp."A" WHERE t.slug = 'acadia'`));
  expect(named.rows.map((r) => r.email)).toEqual([ADMIN]);

  // The same photograph, uploaded again by the same outsider, is no longer swept onto the trip.
  await theirs.goto("/upload");
  await chooseFile(theirs, "photo-with-gps.jpg");
  await expect(theirs.getByText("1 of 1 uploaded.")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT p.status, p."tripId" FROM "Photo" p JOIN "User" u ON u.id = p."uploaderId" WHERE u.email = $1 AND p."trashedAt" IS NULL ORDER BY p."createdAt" DESC LIMIT 1`, [other]))).rows[0], { timeout: 30_000 })
    .toMatchObject({ status: "READY", tripId: null });

  // And the admin's own photographs still land on it, because they are named.
  await page.goto("/upload");
  await chooseFile(page, "photo-with-gps.jpg");
  await expect(page.getByText("1 of 1 uploaded.")).toBeVisible({ timeout: 30_000 });
  const minePicked = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "User" u ON u.id = p."uploaderId" WHERE u.email = $1 ORDER BY p."createdAt" DESC LIMIT 1`, [ADMIN]));
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT t.slug FROM "Photo" p LEFT JOIN "Trip" t ON t.id = p."tripId" WHERE p.id = $1`, [minePicked.rows[0].id]))).rows[0].slug, { timeout: 30_000 })
    .toBe("acadia");

  // Put it back to everybody, so the rest of the file sees the trip it expects.
  await page.goto("/trips/acadia/settings");
  await page.getByTestId("trip-who").getByLabel("e2e-admin@example.com").uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/saved=1/);
  const cleared = await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "_TripParticipants"`));
  expect(cleared.rows[0].n).toBe(0);
  // Everything this test uploaded goes away again: later tests count what is on this trip.
  await withDb((c) => c.query(`DELETE FROM "Photo" p USING "User" u WHERE u.id = p."uploaderId" AND u.email = $1`, [other]));
  await withDb((c) => c.query(`DELETE FROM "Photo" WHERE id = $1`, [minePicked.rows[0].id]));
  await outside.close();
});

test("an activity on the list opens by pressing the card, not only its title", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // A phone, which is where this was reported: the little map beside the title is hidden at this width, so before
  // the whole head of the card became a link there was nothing to press but the words themselves.
  await page.setViewportSize({ width: 390, height: 844 });
  // Put a photograph on the outing, since what was reported is not seeing them: the card must say there is one,
  // and pressing it must land somewhere they are.
  const act = await withDb((c) => c.query(`SELECT id FROM "Activity" WHERE title = 'Ocean Path loop' LIMIT 1`));
  const onIt = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p.status = 'READY' AND p."trashedAt" IS NULL AND p."activityId" IS NULL ORDER BY p.id LIMIT 1`));
  await withDb((c) => c.query(`UPDATE "Photo" SET "activityId" = $2 WHERE id = $1`, [onIt.rows[0].id, act.rows[0].id]));

  await page.goto("/trips/acadia/activities");
  const card = page.locator("article").first();
  // The card says what is inside it, which is the other half of "I do not see the photos".
  await expect(card).toContainText("1 photo");
  // Press the middle of the card, well away from the title.
  await card.click({ position: { x: 200, y: 120 } });
  await expect(page).toHaveURL(/\/trips\/acadia\/activities\/[a-z0-9]+$/);
  await expect(page.getByRole("heading", { name: "Ocean Path loop" })).toBeVisible();
  await expect(page.locator("li.tile-lazy").first()).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await withDb((c) => c.query(`UPDATE "Photo" SET "activityId" = NULL WHERE id = $1`, [onIt.rows[0].id]));
});

test("a photograph can be taken off an activity and stays on the trip", async ({ context, page }) => {
  await signIn(context, ADMIN);
  const act = await withDb((c) => c.query(`SELECT id FROM "Activity" WHERE title = 'Ocean Path loop' LIMIT 1`));
  const activityId = act.rows[0].id as string;
  const mine = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p.status = 'READY' AND p."trashedAt" IS NULL AND p."activityId" IS NULL ORDER BY p.id LIMIT 1`));
  const onIt = mine.rows[0].id as string;
  // The album files a photograph onto whichever outing was happening at the time. Two people on one afternoon do two
  // different things, so that guess has to be correctable from the activity's own page — not only by dragging on the
  // timeline, which a phone cannot do.
  await withDb((c) => c.query(`UPDATE "Photo" SET "activityId" = $2 WHERE id = $1`, [onIt, activityId]));

  await page.goto(`/trips/acadia/activities/${activityId}`);
  await page.getByTestId("activity-select").click();
  await page.locator(`li.tile-lazy:has(img[src*='/api/photos/${onIt}/']) button[aria-pressed]`).first().click();
  await page.getByTestId("take-off-activity").click();
  await expect(page.getByRole("status")).toContainText("still on the trip");
  await expect(page.locator(`li.tile-lazy:has(img[src*='/api/photos/${onIt}/'])`)).toHaveCount(0);

  // Off the outing, still in the album: the trip keeps it, under its own day.
  const after = await withDb((c) => c.query(`SELECT "activityId", "tripId", "trashedAt" FROM "Photo" WHERE id = $1`, [onIt]));
  expect(after.rows[0].activityId).toBeNull();
  expect(after.rows[0].trashedAt).toBeNull();
  expect(after.rows[0].tripId).not.toBeNull();
});

test("the guide is a page anyone can read, with the same words available as a PDF", async ({ page }) => {
  // A guide nobody can reach is no guide. It is a page, linked from the menu, and open to anyone who gets as far
  // as the site — somebody who cannot sign in is exactly who needs to read how signing in works.
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Help" }).first()).toHaveAttribute("href", "/guide");
  await page.goto("/guide");
  await expect(page.getByRole("heading", { name: "Family Album", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Getting in/ })).toBeVisible();
  // The contents jump within the page rather than to another one.
  await page.getByRole("link", { name: "Fixing something that is wrong" }).click();
  await expect(page).toHaveURL(/#fixing$/);
  // And the printable copy is the same guide, one link away.
  await expect(page.getByTestId("guide-pdf")).toHaveAttribute("href", "/guide.pdf");
  const pdf = await page.request.get("/guide.pdf");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("pdf");
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

  // The first photo uploaded to each of the two trips, whatever else has landed on them by now.
  const photos = await withDb((c) => c.query('SELECT DISTINCT ON (t.slug) p.id, t.slug FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug IN (\'acadia\', \'yosemite\') ORDER BY t.slug, p."createdAt"'));
  expect(photos.rows).toHaveLength(2);
  // One photo through the item's own collections field, the other through the collection's "Add existing photos".
  await page.goto(`/photos/${photos.rows[0].id}`);
  await page.waitForLoadState("networkidle");
  // The field searches rather than listing every collection there is: type, then take the hit.
  const collectionField = page.getByTestId("collection-multi-picker");
  await collectionField.getByRole("combobox").fill("Best of");
  await collectionField.getByRole("option", { name: /Best of 2025/ }).click();
  await expect(collectionField.getByRole("listitem").filter({ hasText: "Best of 2025" })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // Wait for the save to land before reloading, or the reload cancels the form post that is still in flight.
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "CollectionItem" WHERE "photoId" = $1', [photos.rows[0].id]))).rows[0].n, { timeout: 20_000 })
    .toBe(1);
  // What the photo is in comes back as a chip that is also the way into the collection, without the rest of the
  // library alongside it.
  await page.reload();
  await expect(page.getByTestId("collection-multi-picker").getByRole("link", { name: "Best of 2025" })).toHaveAttribute("href", "/collections/best-of-2025");
  await expect(page.getByTestId("collection-multi-picker").getByRole("listitem").filter({ hasText: "Best of 2025" })).toBeVisible();
  await page.goto("/collections/best-of-2025");
  await page.getByRole("link", { name: "Add existing photos" }).first().click();
  await expect(page).toHaveURL(/\/collections\/best-of-2025\/add$/);
  const picker = page.getByTestId("add-photos");
  await expect(picker.getByText("1 item to choose from")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await picker.locator(`button:has(img[src*='/api/photos/${photos.rows[1].id}/'])`).click();
  await expect(picker.getByText("1 selected")).toBeVisible();
  await picker.getByRole("button", { name: /Add 1 to collection/ }).click();
  await expect(page).toHaveURL(/\/collections\/best-of-2025\/photos\?added=1$/);
  await expect(page.getByRole("status")).toContainText("Added 1 photo");
  await expect(page.getByRole("heading", { name: /2 items/ })).toBeVisible();
  // The picker filters by date and searches descriptions as well as captions, and says in words what it is showing.
  await page.goto("/collections/best-of-2025/add?from=2001-01-01&to=2001-01-02");
  await expect(page.getByTestId("add-photos").getByText(/0 items to choose from/)).toBeVisible();
  await expect(page.getByTestId("add-photos").getByText(/2001-01-01 to 2001-01-02/)).toBeVisible();

  await page.goto("/collections/best-of-2025/settings");
  await page.getByLabel("Anyone with the link").check();
  // Sharing private-trip photos by link widens their exposure, so the form asks first.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Save changes" }).click();
  const shareUrl = (await page.getByTestId("copy-link").getByRole("textbox").first().inputValue()).trim();
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
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Share", { exact: true })).toBeVisible();
  expect(dialogText).toContain("anyone on the internet");

  // Lowering: Acadia is private, but its photo sits in the now-public collection, so the trip settings say so.
  //
  // Wait for that to be true before asking the page about it. The collection was filled through the interface by
  // the test before this one, and asserting on the page while the album was still catching up read as the warning
  // being missing when it was the photograph that had not arrived.
  await expect
    .poll(async () => (await withDb((c) => c.query(`
      SELECT count(*)::int AS n FROM "CollectionItem" ci
      JOIN "Collection" c ON c.id = ci."collectionId"
      JOIN "Photo" p ON p.id = ci."photoId"
      JOIN "Trip" t ON t.id = p."tripId"
      WHERE c.slug = 'best-of-2025' AND t.slug = 'acadia' AND p."trashedAt" IS NULL`))).rows[0].n, { timeout: 20_000, intervals: [500] })
    .toBeGreaterThan(0);
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
  // The picker searches instead of listing everything; typing a couple of letters is enough.
  await page.getByLabel("Add to collection…").fill("Best of");
  await page.getByRole("option", { name: /Best of 2025/ }).click();
  dialogText = "";
  page.once("dialog", (d) => { dialogText = d.message(); void d.accept(); });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("added to the collection");
  expect(dialogText).toContain("only family members could see");
  await page.getByRole("button", { name: "Select photos" }).click();
  await page.locator("li button").first().click();
  await page.getByLabel("Add to trip…").fill("Yosem");
  await page.getByRole("option", { name: /Yosemite/ }).click();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("moved");
  await page.goto("/trips/yosemite/photos");
  await expect(page.getByRole("heading", { name: /2 photos/ })).toBeVisible();

  // Uploader names are a members-only layer.
  await page.goto("/collections/best-of-2025/photos");
  await page.locator("li button").first().click();
  await expect(page.getByText("Uploaded by e2e-admin").first()).toBeVisible();
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto("/collections/best-of-2025/photos");
  await expect(anonPage.locator("img[src*='/api/photos/']").first()).toBeVisible();
  await anonPage.locator("li button").first().click();
  await expect(anonPage.getByRole("dialog")).toBeVisible();
  await expect(anonPage.getByText(/Uploaded by/)).toHaveCount(0);
  await anon.close();
});

test("a trip and a collection are described in the same box, by hand or by the helper", async ({ context, page }) => {
  await signIn(context, ADMIN);
  const before = (await withDb((c) => c.query(`SELECT description FROM "Trip" WHERE slug = 'acadia'`))).rows[0].description as string | null;
  // The same switch the activity's description needs, set here and put back, so the order of this file does not
  // decide whether the helper is on offer.
  await withDb((c) => c.query(`INSERT INTO "AppSetting" (id, "annotationOptInAt", "updatedAt") VALUES ('app', now(), now()) ON CONFLICT (id) DO UPDATE SET "annotationOptInAt" = now()`));

  // A trip: written by hand, in the header where it is read, rather than on the settings form.
  await page.goto("/trips/acadia");
  await page.getByTestId("trip-description-edit").click();
  await page.getByTestId("trip-description-text").fill("Two weeks of fog and lobster rolls.");
  await page.getByTestId("trip-description-save").click();
  await expect(page.getByTestId("trip-description")).toContainText("fog and lobster rolls");
  // It is the trip's own record, and it is what a link to the trip now says about it.
  expect((await withDb((c) => c.query(`SELECT description FROM "Trip" WHERE slug = 'acadia'`))).rows[0].description).toContain("lobster rolls");

  // A collection: the helper writes it, around what the family typed first.
  await page.goto("/collections/best-of-2025");
  await page.getByTestId("collection-description-edit").click();
  await page.getByTestId("collection-description-text").fill("The ones we would show anybody.");
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("collection-describe").click();
  await expect(page.getByTestId("collection-description-text")).toHaveValue(/year worth keeping/);
  await page.getByTestId("collection-description-save").click();
  await expect(page.getByTestId("collection-description")).toContainText(/year worth keeping/);

  // Saving closes the box, and with it the button that spends money; what is left is the paragraph.
  await expect(page.getByTestId("collection-description-text")).toHaveCount(0);
  await expect(page.getByTestId("collection-describe")).toHaveCount(0);

  await withDb((c) => c.query(`UPDATE "Trip" SET description = $1 WHERE slug = 'acadia'`, [before]));
  await withDb((c) => c.query(`UPDATE "Collection" SET description = NULL WHERE slug = 'best-of-2025'`));
  await withDb((c) => c.query(`UPDATE "AppSetting" SET "annotationOptInAt" = NULL WHERE id = 'app'`));
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
  await tile.locator("button:not([data-testid='favorite-photo'])").first().click();
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
  // Refused either way, and the member is told the same thing either way — which is the promise worth testing.
  await expect(page.getByRole("alert").getByText(/limited to 90 seconds/)).toBeVisible({ timeout: 90_000 });
  await chooseFile(page, "clip.mp4");
  await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 90_000 });

  const rows = await withDb((c) => c.query('SELECT id, status, error, "durationS" FROM "Photo" WHERE kind = $1 ORDER BY "createdAt"', ["VIDEO"]));
  const ready = rows.rows.filter((r) => r.status === "READY");
  const refused = rows.rows.filter((r) => r.status === "FAILED");
  // Which of the two refusals happens depends on whether the browser can decode H.264 and read the length: one
  // build refuses before sending a byte, another sends it and the server refuses. So the guarantee is stated as
  // the album keeps the short clip and nothing else — never as which of the two paths the refusal took.
  expect(ready).toHaveLength(1);
  expect(refused.length).toBeLessThanOrEqual(1);
  if (refused.length) expect(refused[0].error).toContain("limited to 90 seconds");
  expect(rows.rows).toHaveLength(ready.length + refused.length);
  expect(Number(ready[0].durationS)).toBeGreaterThan(1.5);
  const videoUrl = `/api/photos/${ready[0].id}/video`;
  const partial = await context.request.get(videoUrl, { headers: { range: "bytes=0-99" } });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-range"]).toMatch(/^bytes 0-99\//);
  expect((await partial.body()).length).toBe(100);
  await page.goto("/trips/yosemite/photos");
  await page.locator("li", { hasText: "0:02" }).first().locator("button:not([data-testid='favorite-photo'])").first().click();
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
  await expect(page.getByText("Uploaded by e2e-admin").first()).toBeVisible();
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
  // Two whole backfills, each waiting on a batch poll that runs on a thirty-second schedule: the default minute is
  // not enough for the work this asks for, whatever the machine is doing.
  test.setTimeout(240_000);
  await signIn(context, ADMIN);
  await page.goto("/admin");
  // Exactly the badge on the annotation panel: the Admin page is long, and a loose match finds other prose.
  await expect(page.getByText("nothing is sent", { exact: true })).toBeVisible();
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
  // The helper's title lands on the item because the member left it empty; it heads the page and its tab.
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Mail boat lunch");
  await expect(page).toHaveTitle(/Mail boat lunch/);
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
    .poll(async () => (await withDb((c) => c.query('SELECT status, succeeded FROM "AnnotationBatch" ORDER BY "createdAt" DESC LIMIT 1'))).rows[0], { timeout: 120_000, intervals: [1500] })
    .toMatchObject({ status: "ENDED", succeeded: count });
  const described = await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = $1 AND p."annotatedAt" IS NOT NULL', ["yosemite"]));
  expect(described.rows[0].n).toBe(count);

  // An item with no location of its own is placed by the same pass, and the page says the pin is a guess.
  const guessed = await withDb((c) => c.query(`SELECT id, lat, "placeEstimateName" FROM "Photo" WHERE "gpsSource" = 'ESTIMATE' LIMIT 1`));
  expect(guessed.rows[0].placeEstimateName).toBe("Inner Harbor, Baltimore");
  await page.goto(`/photos/${guessed.rows[0].id}`);
  const guessedPlace = page.getByTestId("place-editor");
  await expect(guessedPlace.getByText("estimated from the photo")).toBeVisible();
  await expect(guessedPlace.getByText(/Inner Harbor, Baltimore · fairly sure · within about 800 m/)).toBeVisible();
  await expect(guessedPlace.getByText("the Domino Sugar sign across the water")).toBeVisible();
  // Accepting it keeps the position but stops it being a guess, and records who agreed.
  await guessedPlace.getByRole("button", { name: "Use this place" }).click();
  await expect(guessedPlace.getByText("set by e2e-admin")).toBeVisible();
  const accepted = await withDb((c) => c.query('SELECT lat, "gpsSource" FROM "Photo" WHERE id = $1', [guessed.rows[0].id]));
  expect(accepted.rows[0]).toMatchObject({ gpsSource: "MANUAL", lat: guessed.rows[0].lat });

  // A library described before places were ever estimated: the place-only pass asks about it without touching its
  // description, and its answer (a different landmark in the stand-in) is what lands.
  await withDb((c) => c.query(`UPDATE "Photo" SET lat = NULL, lng = NULL, "gpsSource" = NULL, "placeEstimatedAt" = NULL, "placeEstimateName" = NULL WHERE id = $1`, [guessed.rows[0].id]));
  await page.goto("/admin");
  await page.getByLabel("What to ask for").selectOption("place");
  await page.getByRole("button", { name: "Estimate" }).click();
  await expect(status).toContainText("would be sent");
  const places = Number((await status.textContent())!.match(/(\d+) items? would be sent/)![1]);
  expect(places).toBeGreaterThan(0);
  await page.getByLabel(`Type ${places} to confirm`).fill(String(places));
  await page.getByRole("button", { name: "Send to the helper" }).click();
  await expect(page.getByText("Backfill submitted")).toBeVisible();
  await expect
    // The results are applied by a poll job on a thirty-second schedule, so allow for missing one and waiting out
    // the next: forty-five seconds is one tick of slack, which is none at all.
    .poll(async () => (await withDb((c) => c.query('SELECT "placeEstimateName", "gpsSource" FROM "Photo" WHERE id = $1', [guessed.rows[0].id]))).rows[0], { timeout: 120_000, intervals: [1500] })
    .toMatchObject({ placeEstimateName: "Washington Monument", gpsSource: "ESTIMATE" });
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
  // The embedding waits its turn behind other heavy jobs (a transcode from an earlier test can hold the lock), so allow for that.
  await expect.poll(async () => { await page.reload(); return suggestion.count(); }, { timeout: 45_000, intervals: [1000] }).toBe(1);
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
  await expect(page.getByText("recognized · by birthday")).toBeVisible();
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
  // Detection waits its turn behind every other heavy job (transcodes, embeddings, animals), so allow for a queue.
  await expect.poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "Face" WHERE status = $1', ["DETECTED"]))).rows[0].n, { timeout: 60_000 }).toBeGreaterThan(0);
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
  await expect.poll(async () => { await page.reload(); return page.getByText(/Probably/).count(); }, { timeout: 60_000, intervals: [1500] }).toBeGreaterThan(0);
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

  // Choosing a scope actually narrows it. The picker is one <select>, so it sends the kind and the value together
  // under one name, and the page used to read only the plain spelling — so whatever was chosen, nothing changed.
  await page.getByLabel("Scope").selectOption("trip=acadia");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("status")).toContainText(/\d+ items/);
  const onTrip = (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p."embeddedAt" IS NOT NULL AND p.status = 'READY' AND p."trashedAt" IS NULL`))).rows[0].n;
  expect(Number((await page.getByRole("status").textContent())!.match(/(\d+) items/)![1])).toBe(onTrip);
  // Pages carry a per-request nonce policy; the API keeps the frame-only one.
  const res = await request.get("/graph");
  expect(res.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
});

test("a trip and a collection each draw their own photographs by what they look like", async ({ browser, context, page }) => {
  // The album-wide graph is one page with a scope picker; a family looking for the four near-identical shots of the
  // same puddle is looking inside one trip, so each trip and collection draws its own.
  //
  // Asked for as a browser asks, because the trip's frame is already on its way out by the time the page decides
  // there is nobody signed in: the response is a perfectly good 200 carrying a redirect the browser then makes,
  // and the graph is never in it.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto("/trips/acadia/graph");
  await expect(anonPage).toHaveURL(/\/auth\/signin/);
  await expect(anonPage.getByTestId("graph-canvas")).toHaveCount(0);
  await anon.close();

  await signIn(context, ADMIN);
  await expect.poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "MediaSimilarity"'))).rows[0].n, { timeout: 30_000 }).toBeGreaterThan(0);

  await page.goto("/trips/acadia");
  // Scoped to the trip's own tabs: "Graph" is also the album-wide one up in the site's nav.
  await page.getByTestId("trip-tabs").getByRole("link", { name: "Graph", exact: true }).click();
  await expect(page).toHaveURL(/\/trips\/acadia\/graph$/);
  await expect(page.getByRole("status")).toContainText(/\d+ items/);
  await expect(page.getByTestId("graph-canvas").locator("canvas").first()).toBeVisible();
  // Only this trip's photographs: the album-wide graph is wider, and the point of this page is that it is not.
  const here = Number((await page.getByRole("status").textContent())!.match(/(\d+) items/)![1]);
  const onTrip = (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p."embeddedAt" IS NOT NULL AND p.status = 'READY' AND p."trashedAt" IS NULL`))).rows[0].n;
  expect(here).toBe(onTrip);

  // Wait for the collection to actually hold something the album has looked at, so a slow embedding reads as slow
  // rather than as the page being wrong.
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" JOIN "Photo" p ON p.id = ci."photoId" WHERE c.slug = 'best-of-2025' AND p."embeddedAt" IS NOT NULL AND p.status = 'READY' AND p."trashedAt" IS NULL`))).rows[0].n, { timeout: 30_000, intervals: [500] })
    .toBeGreaterThan(1);
  await page.goto("/collections/best-of-2025");
  await page.getByTestId("trip-tabs").getByRole("link", { name: "Graph", exact: true }).click();
  await expect(page).toHaveURL(/\/collections\/best-of-2025\/graph$/);
  await expect(page.getByTestId("graph-canvas").locator("canvas").first()).toBeVisible();
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
  // Transcoding a clip keeps the date Google recorded for it rather than falling back to the file's own.
  const clip = await withDb((c) => c.query(`SELECT "takenAtSource" FROM "Photo" WHERE "originalName" = 'clip.mp4' AND "sourceKind" = 'TAKEOUT'`));
  expect(clip.rows[0].takenAtSource).toBe("SIDECAR");
  const album = await withDb((c) => c.query(`SELECT visibility, "shareToken" FROM "Collection" WHERE title = 'Lake House'`));
  expect(album.rows[0]).toEqual({ visibility: "PRIVATE", shareToken: null });
  await page.reload();
  await expect(page.getByTestId("takeout-import").first()).toHaveAttribute("data-status", "ENDED");
  await expect(page.getByTestId("takeout-import").first()).toContainText("4 imported");

  // A phone upload loses its position to Android on the way out; a second run of the same export gives it back.
  await withDb((c) => c.query(`UPDATE "Photo" SET lat = NULL, lng = NULL, "gpsSource" = NULL WHERE "originalName" = 'photo-with-gps.jpg'`));
  await page.waitForLoadState("networkidle");
  await page.getByTestId("takeout-admin").getByText("takeout-e2e.zip").locator("..").locator("..").getByRole("button", { name: "Import" }).click();
  await expect.poll(async () => (await withDb((c) => c.query('SELECT count(*)::int AS n FROM "TakeoutImport" WHERE status = $1', ["ENDED"]))).rows[0].n, { timeout: 60_000 }).toBe(2);
  const repaired = await withDb((c) => c.query(`SELECT lat, lng, "gpsSource" FROM "Photo" WHERE "originalName" = 'photo-with-gps.jpg' AND "sourceKind" = 'TAKEOUT'`));
  expect(repaired.rows[0]).toEqual({ lat: 44.3186, lng: -68.1917, gpsSource: "SIDECAR" });
  await page.reload();
  await expect(page.getByTestId("takeout-import").first()).toContainText("1 repaired");
  await expect(page.getByTestId("takeout-import").first()).toContainText("0 imported");
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
  await expect(page.getByText("Add places here, or file these to a trip")).toBeVisible();
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
  // The viewer's side panel: date, an Edit link for members, and a date that can be changed and put back.
  const info = dialog.getByTestId("lightbox-info");
  await expect(info.getByTestId("lightbox-edit")).toHaveAttribute("href", `/photos/${first.rows[0].id}`);
  await expect(info.getByText("Uploaded by e2e-admin")).toBeVisible();
  await expect(dialog.locator(`a[href*='/api/photos/${first.rows[0].id}/original']`)).toBeVisible();
  await info.getByRole("button", { name: "Change date" }).click();
  await info.getByLabel("Date taken").fill("2019-07-04T10:30");
  await info.getByRole("button", { name: "Save date" }).click();
  await expect(info.getByText("set by e2e-admin")).toBeVisible();
  const manual = await withDb((c) => c.query('SELECT "takenAtSource", "takenAt" FROM "Photo" WHERE id = $1', [first.rows[0].id]));
  expect(manual.rows[0].takenAtSource).toBe("MANUAL");
  expect(new Date(manual.rows[0].takenAt).getUTCFullYear()).toBe(2019);
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

test("the uploader crops and color-corrects a photo, and the original stays untouched", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/upload");
  await chooseFile(page, "photo-with-gps.jpg");
  await expect(page.getByText("1 of 1 uploaded.")).toBeVisible({ timeout: 30_000 });
  const row = await withDb((c) => c.query(`SELECT id, renditions FROM "Photo" WHERE "originalName" = 'photo-with-gps.jpg' ORDER BY "createdAt" DESC LIMIT 1`));
  const id = row.rows[0].id as string;
  const before = row.rows[0].renditions as { medium: { w: number; h: number } };

  await page.goto(`/photos/${id}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Crop and color" }).click();
  await expect(page.getByTestId("photo-editor")).toBeVisible();
  await page.getByLabel("Warmth").fill("40");
  await page.getByRole("button", { name: "Turn right" }).click();
  // Auto levels is measured from the picture on screen rather than promised: this fixture is one flat colour, so
  // the editor says plainly that there is nothing to stretch instead of claiming the toggle will do something.
  // The preview really shows the picture: a broken load here would leave every slider working on nothing.
  await expect.poll(async () => page.getByAltText("The photo as it will look").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  const matrix = page.locator("filter feColorMatrix").first();
  const plain = await matrix.getAttribute("values");
  await page.getByRole("button", { name: "Auto levels" }).click();
  await expect(page.getByText(/nothing here for auto levels to stretch/)).toBeVisible();
  expect(await matrix.getAttribute("values")).toBe(plain);
  // The colour sliders do move the filter the picture is drawn through, which is the preview doing its job.
  await page.getByLabel("Contrast").fill("1.4");
  await expect.poll(async () => matrix.getAttribute("values")).not.toBe(plain);
  await page.getByRole("button", { name: "Auto levels" }).click(); // leave it off for what follows
  await page.getByLabel("Contrast").fill("1");
  await page.getByRole("button", { name: "Save edits" }).click();

  // The instructions are stored at once; the renditions are then made again from the original in the background,
  // which is what turns the picture, so wait for that rather than for the row.
  await expect
    .poll(async () => {
      const r = (await withDb((c) => c.query('SELECT edits, renditions FROM "Photo" WHERE id = $1', [id]))).rows[0];
      return { edits: r.edits, full: Boolean(r.renditions?.full) };
    }, { timeout: 60_000, intervals: [1500] })
    .toMatchObject({ edits: { rotate: 90, warmth: 40 }, full: true });
  const after = (await withDb((c) => c.query('SELECT renditions, width, height FROM "Photo" WHERE id = $1', [id]))).rows[0];
  expect(after.renditions.medium.w).toBe(before.medium.h);

  // Reopening the editor starts from the picture without its edits, so they are not applied a second time.
  const sourceCopy = await page.request.get(`/api/photos/${id}/source`);
  expect(sourceCopy.ok()).toBe(true);

  // The page says so and offers the file as it was uploaded, which still opens.
  await page.reload();
  await expect(page.getByTestId("edited-note")).toContainText("see the original");
  const original = await page.request.get(`/api/photos/${id}/original`);
  expect(original.ok()).toBe(true);
  expect(original.headers()["content-type"]).toContain("image/jpeg");
  const edited = await page.request.get(`/api/photos/${id}/edited`);
  expect(edited.ok()).toBe(true);
  expect(edited.headers()["content-type"]).toContain("image/webp");

  // Reverting forgets the instructions and puts the picture back the way round it was.
  await page.getByRole("button", { name: "Edit again" }).click();
  await page.getByRole("button", { name: "Back to the original" }).click();
  await expect
    .poll(async () => {
      const r = (await withDb((c) => c.query('SELECT edits, renditions FROM "Photo" WHERE id = $1', [id]))).rows[0];
      return { edits: r.edits, width: r.renditions?.medium?.w };
    }, { timeout: 60_000, intervals: [1500] })
    .toEqual({ edits: null, width: before.medium.w });
  const reverted = (await withDb((c) => c.query('SELECT renditions FROM "Photo" WHERE id = $1', [id]))).rows[0];
  expect(reverted.renditions.full).toBeUndefined();
});

test("a favorite leads the list, and a tile says what it is on hover", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/trips/acadia/photos");
  const tiles = page.locator("ul li.tile-lazy");
  await expect(tiles.first()).toBeVisible();
  // Which photo a tile shows, not which URL: the version on the end of the URL changes whenever anything touches
  // the item, including a background job finishing from an earlier test.
  const photoOf = async (tile: Locator) => (await tile.locator("img").getAttribute("src"))?.match(/\/api\/photos\/([^/]+)\//)?.[1] ?? null;
  const before = await photoOf(tiles.first());
  const count = await tiles.count();
  expect(count).toBeGreaterThan(1);

  // Mark the last one: it should move to the front, because a member's own favourites lead.
  const last = tiles.nth(count - 1);
  const lastPhoto = await photoOf(last);
  expect(lastPhoto).not.toBe(before);
  await last.getByTestId("favorite-photo").click();
  await expect
    .poll(async () => {
      await page.reload();
      return photoOf(page.locator("ul li.tile-lazy").first());
    }, { timeout: 20_000, intervals: [1000] })
    .toBe(lastPhoto);
  // The heart shows it is mine, and how many of us have marked it.
  await expect(page.locator("ul li.tile-lazy").first().getByTestId("favorite-photo")).toHaveAttribute("aria-pressed", "true");

  // What a tile says without opening it: the caption, and when and where.
  const hover = page.locator("ul li.tile-lazy").first().getByTestId("tile-hover");
  await expect(hover).toContainText(/Aug|Sep|\d{4}/);

  // Trips are ordered the same way.
  await page.goto("/");
  // Not the "New trip" button, which is also a link starting /trips/.
  const cards = page.locator("a[href^='/trips/']:not([href='/trips/new'])");
  await expect(cards.first()).toBeVisible();
  // Read which card it is before marking it: the mark re-orders the grid, so asking afterwards asks about a
  // different card.
  const lastHeart = page.getByTestId("favorite-trip").last();
  const favourited = await lastHeart.locator("xpath=ancestor::a").getAttribute("href");
  await lastHeart.click();
  await expect
    .poll(async () => {
      await page.reload();
      return page.locator("a[href^='/trips/']:not([href='/trips/new'])").first().getAttribute("href");
    }, { timeout: 20_000, intervals: [1000] })
    .toBe(favourited);
});

test("a photograph is favorited while looking at it, and turns up under Favorites for the album, the trip and the collection", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  // One the admin has not marked yet, so the test proves its own heart rather than finding an earlier one.
  const pick = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" JOIN "User" u ON u.email = $1 WHERE t.slug = 'acadia' AND p.kind = 'PHOTO' AND p.status = 'READY' AND p."trashedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "PhotoFavorite" f WHERE f."photoId" = p.id AND f."userId" = u.id) ORDER BY p.id LIMIT 1`, [ADMIN]));
  const id = pick.rows[0].id as string;
  const tileOf = (pg: Page) => pg.locator(`li.tile-lazy:has(img[src*='/api/photos/${id}/'])`);

  // Open it big, and mark it from there — the heart is the first thing in the panel beside the picture.
  await page.goto("/trips/acadia/photos");
  await tileOf(page).locator("img").first().click();
  const heart = page.getByTestId("lightbox-info").getByTestId("favorite-photo");
  await expect(heart).toHaveAttribute("aria-pressed", "false");
  await expect(heart).toContainText("Add to favorites");
  await heart.click();
  await expect(heart).toHaveAttribute("aria-pressed", "true");
  await expect(heart).toContainText("Favorite");
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "PhotoFavorite" f JOIN "User" u ON u.id = f."userId" WHERE f."photoId" = $1 AND u.email = $2`, [id, ADMIN]))).rows[0].n)
    .toBe(1);
  await page.keyboard.press("Escape");

  // The trip's own Favourites tab, mine and everyone's.
  await page.goto("/trips/acadia");
  await page.getByTestId("trip-tabs").getByRole("link", { name: "Favorites" }).click();
  await expect(page).toHaveURL(/\/trips\/acadia\/favorites$/);
  await expect(tileOf(page)).toBeVisible();
  await page.getByTestId("favorites-family").click();
  await expect(page).toHaveURL(/who=family/);
  await expect(tileOf(page)).toBeVisible();

  // The whole album's, from the menu.
  await page.goto("/");
  await page.getByRole("link", { name: "Favorites" }).first().click();
  await expect(page).toHaveURL(/\/favorites$/);
  await expect(tileOf(page)).toBeVisible();

  // A collection's, which only shows what is in it: put the photograph in one, and it is there too.
  const col = await withDb((c) => c.query(`SELECT id, slug FROM "Collection" ORDER BY "createdAt" LIMIT 1`));
  // Already in it is fine too; only a row this test added is taken out again at the end.
  await withDb((c) => c.query(`INSERT INTO "CollectionItem" (id, "collectionId", "photoId", "position", "addedById", "createdAt") VALUES (md5(random()::text), $1, $2, 9999, (SELECT id FROM "User" WHERE email = $3), now()) ON CONFLICT DO NOTHING`, [col.rows[0].id, id, ADMIN]));
  await page.goto(`/collections/${col.rows[0].slug}/favorites`);
  await expect(tileOf(page)).toBeVisible();

  // Somebody without an account has no favourites, and is not shown anybody else's.
  const anon = await browser.newContext();
  const stranger = await anon.newPage();
  const res = await stranger.goto("/trips/acadia/favorites");
  expect([200, 404]).toContain(res?.status());
  await expect(tileOf(stranger)).toHaveCount(0);
  await anon.close();

  // Let it go again from the favourites page itself, and leave the album as it was found.
  await page.goto("/trips/acadia/favorites");
  await tileOf(page).getByTestId("favorite-photo").click();
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "PhotoFavorite" f JOIN "User" u ON u.id = f."userId" WHERE f."photoId" = $1 AND u.email = $2`, [id, ADMIN]))).rows[0].n)
    .toBe(0);
  await withDb((c) => c.query(`DELETE FROM "CollectionItem" WHERE "collectionId" = $1 AND "photoId" = $2 AND "position" = 9999`, [col.rows[0].id, id]));

  // And from the timeline, where most photographs are actually looked at: the same heart on the same tile.
  await page.goto("/trips/acadia");
  const onTimeline = tileOf(page).getByTestId("favorite-photo");
  await expect(onTimeline).toHaveAttribute("aria-pressed", "false");
  await onTimeline.click();
  await expect(onTimeline).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "PhotoFavorite" f JOIN "User" u ON u.id = f."userId" WHERE f."photoId" = $1 AND u.email = $2`, [id, ADMIN]))).rows[0].n)
    .toBe(1);
  // The old British address still lands on the page it moved to.
  await page.goto("/trips/acadia/favourites");
  await expect(page).toHaveURL(/\/trips\/acadia\/favorites$/);
  await expect(tileOf(page)).toBeVisible();
  await withDb((c) => c.query(`DELETE FROM "PhotoFavorite" f USING "User" u WHERE u.id = f."userId" AND f."photoId" = $1 AND u.email = $2`, [id, ADMIN]));
});

test("the date troubleshooter shows every witness and lets one be taken", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // An uploaded photo with a file of its own: one imported through Google's picker has no file to read a modified
  // time from, so the only reading it carries is the one it already has and there would be nothing to take.
  const scan = await withDb((c) => c.query(`SELECT id FROM "Photo" WHERE kind = 'PHOTO' AND "sourceKind" = 'UPLOAD' AND "takenAtSource" IN ('FILE_MTIME','UPLOAD_TIME') ORDER BY "createdAt" LIMIT 1`));
  const row = scan.rows[0] ?? (await withDb((c) => c.query(`SELECT id FROM "Photo" WHERE kind = 'PHOTO' AND "sourceKind" = 'UPLOAD' ORDER BY "createdAt" LIMIT 1`))).rows[0];
  await page.goto(`/photos/${row.id}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Where did this date come from?" }).click();
  const report = page.getByTestId("date-report");
  await expect(report).toBeVisible();
  await expect(report).toContainText("The camera (EXIF DateTimeOriginal)");
  await expect(report).toContainText("The file's modified time");
  await expect(report).toContainText("When it was uploaded");
  // Taking a reading records it as set by hand.
  await report.getByRole("button", { name: "Use this" }).first().click();
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT "takenAtSource" FROM "Photo" WHERE id = $1', [row.id]))).rows[0].takenAtSource, { timeout: 20_000 })
    .toBe("MANUAL");
});

test("a day of wrong dates is corrected in one go from the timeline, which says which year it is", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/trips/acadia");
  // A family album spans decades: the day heading names the year, not just the weekday and month.
  await expect(page.locator("h2").first()).toContainText(/\d{4}/);

  const tripPhotos = async () =>
    (await withDb((c) => c.query(`SELECT id, "takenAt" FROM "Photo" WHERE "tripId" = (SELECT id FROM "Trip" WHERE slug = 'acadia') AND "takenAt" IS NOT NULL ORDER BY id`))).rows as { id: string; takenAt: Date }[];
  const before = await tripPhotos();
  expect(before.length).toBeGreaterThan(0);

  const shiftDay = async (minutes: number) => {
    await page.getByTestId("day-select").first().click();
    await page.getByRole("button", { name: "Fix dates…" }).click();
    await page.getByLabel("Shift them by the same amount").check();
    await page.getByLabel("Minutes").fill(String(minutes));
    const preview = page.getByTestId("bulk-date-preview");
    await expect(preview).toContainText("→");
    await page.getByRole("button", { name: "Correct these dates" }).click();
  };

  await shiftDay(2);
  // At least the photos under that heading moved by exactly two minutes, and are now dated by hand.
  await expect
    .poll(async () => {
      const now = await tripPhotos();
      return now.filter((p, i) => new Date(p.takenAt).getTime() - new Date(before[i].takenAt).getTime() === 120_000).length;
    }, { timeout: 20_000, intervals: [1000] })
    .toBeGreaterThan(0);
  const moved = (await tripPhotos()).filter((p, i) => new Date(p.takenAt).getTime() !== new Date(before[i].takenAt).getTime()).map((p) => p.id);
  const sources = await withDb((c) => c.query('SELECT DISTINCT "takenAtSource" FROM "Photo" WHERE id = ANY($1)', [moved]));
  expect(sources.rows.map((r: { takenAtSource: string }) => r.takenAtSource)).toEqual(["MANUAL"]);

  // And the same correction the other way puts them back.
  await page.goto("/trips/acadia");
  await shiftDay(-2);
  await expect
    .poll(async () => {
      const now = await tripPhotos();
      return now.every((p, i) => new Date(p.takenAt).getTime() === new Date(before[i].takenAt).getTime());
    }, { timeout: 20_000, intervals: [1000] })
    .toBe(true);
});

test("a family member moves an item to the trash with a reason, and an admin restores it or deletes it for good", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  // A plain member, not an admin: trashing is something anyone in the family may do.
  const memberEmail = "e2e-member@example.com";
  await page.goto("/admin");
  await page.getByLabel("Email address").fill(memberEmail);
  await page.getByRole("button", { name: /Send invite|Invite/ }).click();
  await expect(page.getByText(`Invitation sent to ${memberEmail}`)).toBeVisible();
  const memberContext = await browser.newContext();
  await signIn(memberContext, memberEmail);
  const memberPage = await memberContext.newPage();

  // Two items on a public trip: one to trash, one to prove the rest of the album is untouched.
  await memberPage.goto("/upload");
  await chooseFile(memberPage, "photo-no-gps.jpg");
  await expect(memberPage.getByText("1 of 1 uploaded.")).toBeVisible({ timeout: 30_000 });
  const fresh = await withDb((c) => c.query(`SELECT id FROM "Photo" WHERE "originalName" = 'photo-no-gps.jpg' ORDER BY "createdAt" DESC LIMIT 1`));
  const victim = fresh.rows[0].id as string;
  await withDb((c) => c.query(`UPDATE "Photo" SET caption = 'trashcandidate lobster', "searchVector" = to_tsvector('english', 'trashcandidate lobster'), "searchVectorMembers" = to_tsvector('english', 'trashcandidate lobster') WHERE id = $1`, [victim]));
  await memberPage.goto("/search?q=trashcandidate");
  await expect(memberPage.getByRole("status")).toContainText("1 result");

  // Cropping and colour are the uploader's or an admin's: the member sees the way in on their own upload, and not
  // on somebody else's, while the admin sees it on both.
  await memberPage.goto(`/photos/${victim}`);
  await memberPage.waitForLoadState("networkidle");
  await expect(memberPage.getByRole("button", { name: /Crop and colour|Edit again/ })).toBeVisible();
  const adminsOwn = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "User" u ON u.id = p."uploaderId" WHERE u.email = $1 AND p.kind = 'PHOTO' AND p.status = 'READY' LIMIT 1`, [ADMIN]));
  await memberPage.goto(`/photos/${adminsOwn.rows[0].id}`);
  await memberPage.waitForLoadState("networkidle");
  await expect(memberPage.getByRole("button", { name: /Crop and colour|Edit again/ })).toHaveCount(0);
  await page.goto(`/photos/${victim}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /Crop and colour|Edit again/ })).toBeVisible();

  // The member says why, and it leaves the album everywhere at once.
  await memberPage.goto(`/photos/${victim}`);
  await memberPage.waitForLoadState("networkidle");
  await memberPage.getByRole("button", { name: "Move to trash" }).click();
  await memberPage.getByLabel("Why is it going to the trash?").selectOption("DUPLICATE");
  await memberPage.getByRole("button", { name: "Move to trash" }).click();
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT "trashedAt", "trashReason" FROM "Photo" WHERE id = $1', [victim]))).rows[0].trashReason, { timeout: 20_000 })
    .toBe("DUPLICATE");
  await memberPage.goto("/search?q=trashcandidate");
  await expect(memberPage.getByRole("status")).toContainText("Nothing matches");

  // Not even a public trip or a share link reaches its bytes now.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const bytes = await anonPage.request.get(`/api/photos/${victim}/thumb`);
  expect(bytes.status()).toBe(401);
  await anon.close();

  // The admin sees why it went, and puts it back.
  await page.goto("/admin/trash");
  await expect(page.getByText("A duplicate of another item")).toBeVisible();
  await page.getByRole("checkbox", { name: /^Select / }).first().check();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("status")).toContainText("1 item restored");
  await memberPage.goto("/search?q=trashcandidate");
  await expect(memberPage.getByRole("status")).toContainText("1 result");

  // Trashed again, an admin can delete it for good: the row goes and the page is gone.
  await memberPage.goto(`/photos/${victim}`);
  await memberPage.waitForLoadState("networkidle");
  await memberPage.getByRole("button", { name: "Move to trash" }).click();
  await memberPage.getByLabel("Why is it going to the trash?").selectOption("OTHER");
  await memberPage.getByLabel(/Anything to add/).fill("uploaded twice by mistake");
  await memberPage.getByRole("button", { name: "Move to trash" }).click();
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT "trashedAt" FROM "Photo" WHERE id = $1', [victim]))).rows[0]?.trashedAt !== null, { timeout: 20_000 })
    .toBe(true);
  await page.goto("/admin/trash");
  await expect(page.getByText("Something else — uploaded twice by mistake")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("checkbox", { name: /^Select / }).first().check();
  await page.getByRole("button", { name: "Delete for good" }).click();
  await expect(page.getByRole("status")).toContainText("1 item deleted for good");
  const gone = await withDb((c) => c.query('SELECT id FROM "Photo" WHERE id = $1', [victim]));
  expect(gone.rows).toHaveLength(0);
  await memberContext.close();
});

test("photos can be uploaded straight into an activity, and stay there when its hours change", async ({ context, page }) => {
  await signIn(context, ADMIN);
  const act = await withDb((c) => c.query(`SELECT id, "startTime" FROM "Activity" WHERE title = 'Ocean Path loop' LIMIT 1`));
  const activityId = act.rows[0].id as string;
  await page.goto(`/trips/acadia/activities/${activityId}`);
  await page.getByTestId("activity-upload-open").click();
  await chooseFile(page, "photo-no-exif.jpg");
  await expect(page.getByTestId("activity-upload").locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });

  // It is on the activity because a member put it there, not because its date fell inside the walk.
  const newest = async () => (await withDb((c) => c.query('SELECT id, "activityId", "activitySetById", "tripId" FROM "Photo" WHERE "originalName" = $1 ORDER BY "createdAt" DESC LIMIT 1', ["photo-no-exif.jpg"]))).rows[0];
  await expect.poll(async () => (await newest())?.activityId, { timeout: 30_000, intervals: [1000] }).toBe(activityId);
  const row = await newest();
  expect(row.activitySetById).not.toBeNull();
  expect(row.tripId).not.toBeNull();

  await page.reload();
  await expect(page.getByRole("heading", { name: /photo/ })).toBeVisible();

  // Editing the activity re-files photos by time; one a member placed is not swept out again.
  await page.goto(`/trips/acadia/activities/${activityId}?edit=1`);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(`**/activities/${activityId}`);
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT "activityId" FROM "Photo" WHERE id = $1', [row.id]))).rows[0].activityId, { timeout: 20_000, intervals: [1000] })
    .toBe(activityId);
});

test("a panorama is recognized, kept long, and shown as a panorama rather than a sliver", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/upload");
  await chooseFile(page, "panorama.jpg");
  await expect(page.locator("img[src*='/api/photos/']").first()).toBeVisible({ timeout: 30_000 });

  // The file's own XMP says it is a full 360, which its 2:1 shape alone would never have told anyone.
  const pano = async () => (await withDb((c) => c.query('SELECT id, status, panorama, "panoProjection" FROM "Photo" WHERE "originalName" = $1 ORDER BY "createdAt" DESC LIMIT 1', ["panorama.jpg"]))).rows[0];
  await expect.poll(async () => (await pano())?.status, { timeout: 30_000, intervals: [1000] }).toBe("READY");
  const row = await pano();
  expect(row.panorama).toBe(true);
  expect(row.panoProjection).toBe("EQUIRECTANGULAR_360");

  // A long copy is kept to pan across, beyond the 1600-pixel one every other photo gets.
  const long = await page.request.get(`/api/photos/${row.id}/pano`);
  expect(long.ok()).toBe(true);

  // Its own page shows it in a viewer that is dragged, and says what it is.
  await page.goto(`/photos/${row.id}`);
  await expect(page.getByTestId("panorama-view")).toBeVisible();
  await expect(page.getByText(/360° panorama/).first()).toBeVisible();

  // And in a grid it gets a tile of its own shape instead of a square crop of its middle.
  await page.goto("/photos");
  const tile = page.locator("li.tile-lazy").filter({ has: page.locator(`img[src*='/api/photos/${row.id}/']`) });
  await expect(tile).toHaveClass(/col-span-2/);
  await expect(tile.getByText("360°")).toBeVisible();
});

test("a member edits their own photos and reads everyone else's, and a trip is arranged by whoever made it", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  const memberEmail = "e2e-member@example.com";
  const memberContext = await browser.newContext();
  await signIn(memberContext, memberEmail);
  const memberPage = await memberContext.newPage();

  // One of the member's own, uploaded here so the test does not depend on what earlier tests left behind.
  await memberPage.goto("/upload");
  await chooseFile(memberPage, "photo-no-gps.jpg");
  await expect(memberPage.getByText("1 of 1 uploaded.")).toBeVisible({ timeout: 30_000 });
  const mine = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "User" u ON u.id = p."uploaderId" WHERE u.email = $1 AND p.kind = 'PHOTO' AND p."trashedAt" IS NULL ORDER BY p."createdAt" DESC LIMIT 1`, [memberEmail]));
  const theirs = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "User" u ON u.id = p."uploaderId" WHERE u.email = $1 AND p.kind = 'PHOTO' AND p."trashedAt" IS NULL ORDER BY p."createdAt" LIMIT 1`, [ADMIN]));

  // Their own: the details form is there to write in.
  await memberPage.goto(`/photos/${mine.rows[0].id}`);
  await memberPage.waitForLoadState("networkidle");
  await expect(memberPage.getByLabel("Caption")).toBeVisible();
  await expect(memberPage.getByTestId("not-yours")).toHaveCount(0);

  // Somebody else's: the same page, read-only, with the rule said plainly — and the trash still open to them.
  await memberPage.goto(`/photos/${theirs.rows[0].id}`);
  await memberPage.waitForLoadState("networkidle");
  await expect(memberPage.getByTestId("not-yours")).toBeVisible();
  await expect(memberPage.getByLabel("Caption")).toHaveCount(0);
  await expect(memberPage.getByRole("button", { name: /Move to trash/ })).toBeVisible();

  // The server says the same thing to the viewer panel, which is what the lightbox reads.
  const own = await memberPage.request.get(`/api/photos/${mine.rows[0].id}/info`);
  expect((await own.json()).editable).toBe(true);
  const other = await memberPage.request.get(`/api/photos/${theirs.rows[0].id}/info`);
  expect((await other.json()).editable).toBe(false);

  // A trip the admin made is arranged by the admin: no Settings tab for the member, and the page itself says no.
  await memberPage.goto("/trips/acadia");
  await expect(memberPage.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await memberPage.goto("/trips/acadia/settings");
  await expect(memberPage).toHaveURL(/\/trips\/acadia$/);
  await page.goto("/trips/acadia");
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
});

test("a photo is dragged onto an activity on the timeline, and a selection can be put there without dragging", async ({ context, page }) => {
  await signIn(context, ADMIN);
  const act = await withDb((c) => c.query(`SELECT id, title FROM "Activity" WHERE title = 'Ocean Path loop' LIMIT 1`));
  const activityId = act.rows[0].id as string;
  // A photo of the admin's on the trip but on no activity: the one the timeline shows loose under its day.
  const loose = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "User" u ON u.id = p."uploaderId" WHERE p."tripId" = (SELECT id FROM "Trip" WHERE slug = 'acadia') AND p."activityId" IS NULL AND p.status = 'READY' AND p."trashedAt" IS NULL AND u.email = $1 ORDER BY p."createdAt" LIMIT 1`, [ADMIN]));
  test.skip(loose.rows.length === 0, "no loose photo on the trip to drag");
  const photoId = loose.rows[0].id as string;

  await page.goto("/trips/acadia");
  await page.waitForLoadState("networkidle");
  const tile = page.locator(`li.tile-lazy:has(img[src*='/api/photos/${photoId}/'])`).first();
  await expect(tile).toBeVisible();
  // The drag is played out by hand — one DataTransfer carried from the tile's dragstart to the activity's drop, as
  // a browser does — because Playwright's own drag dispatch does not reach this Chromium build reliably. What is
  // under test is what the album does with the drag: pick the id up, take it, and file the photograph.
  await page.evaluate(({ id, activity }) => {
    const from = document.querySelector(`li.tile-lazy:has(img[src*='/api/photos/${id}/'])`)!;
    const onto = document.querySelector(`[data-testid='drop-activity'][data-drop-target='${activity}']`)!;
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
    onto.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    onto.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { id: photoId, activity: activityId });

  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT "activityId", "activitySetById" FROM "Photo" WHERE id = $1', [photoId]))).rows[0], { timeout: 20_000, intervals: [1000] })
    .toMatchObject({ activityId });
  const row = (await withDb((c) => c.query('SELECT "activitySetById" FROM "Photo" WHERE id = $1', [photoId]))).rows[0];
  expect(row.activitySetById).not.toBeNull();

  // The same thing without a drag, which is the only way on a phone: select, pick the activity, put them in.
  await withDb((c) => c.query('UPDATE "Photo" SET "activityId" = NULL, "activitySetById" = NULL WHERE id = $1', [photoId]));
  await page.goto("/trips/acadia");
  await page.getByRole("button", { name: "Select photos" }).click();
  await page.getByTestId("day-select").first().click();
  const picker = page.getByTestId("activity-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("combobox").click();
  await picker.getByRole("option", { name: /Ocean Path loop/ }).click();
  await page.getByRole("button", { name: "Put in", exact: true }).click();
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT "activityId" FROM "Photo" WHERE id = $1', [photoId]))).rows[0].activityId, { timeout: 20_000, intervals: [1000] })
    .toBe(activityId);
});

test("a cover is chosen from the photographs themselves, by whoever made the trip", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/trips/acadia/settings");
  await page.getByRole("link", { name: "Choose a cover" }).click();
  await expect(page).toHaveURL(/\/trips\/acadia\/cover$/);

  // Nobody has chosen one yet, so the album says which it is leading with.
  const picker = page.getByTestId("cover-picker");
  await expect(picker).toBeVisible();
  const tiles = picker.locator("li");
  const chosen = (await tiles.nth(1).locator("img").getAttribute("src"))?.match(/\/api\/photos\/([^/]+)\//)?.[1];
  await tiles.nth(1).getByRole("button").click();
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT "coverPhotoId" FROM "Trip" WHERE slug = 'acadia'`))).rows[0].coverPhotoId, { timeout: 20_000, intervals: [1000] })
    .toBe(chosen);
  await expect(page.getByText("This one was chosen by hand.")).toBeVisible();

  // And handing it back leaves the album to lead with the earliest photograph again.
  await page.getByRole("button", { name: "Let the album choose" }).click();
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT "coverPhotoId" FROM "Trip" WHERE slug = 'acadia'`))).rows[0].coverPhotoId, { timeout: 20_000, intervals: [1000] })
    .toBeNull();

  // A member who did not make the trip is not offered it, and the page turns them away.
  const memberContext = await context.browser()!.newContext();
  await signIn(memberContext, "e2e-member@example.com");
  const memberPage = await memberContext.newPage();
  await memberPage.goto("/trips/acadia/photos");
  await expect(memberPage.getByRole("link", { name: "Cover photo" })).toHaveCount(0);
  await memberPage.goto("/trips/acadia/cover");
  await expect(memberPage).toHaveURL(/\/trips\/acadia$/);
});

test("photographs with no place are dropped onto the map, several at a time", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // Something of the admin's with no position at all: the map cannot know where a file with no GPS was taken.
  await withDb((c) => c.query(`UPDATE "Photo" SET lat = NULL, lng = NULL, "gpsSource" = NULL WHERE "originalName" = 'photo-no-exif.jpg'`));
  const waiting = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "User" u ON u.id = p."uploaderId" WHERE u.email = $1 AND p.lat IS NULL AND p.status = 'READY' AND p."trashedAt" IS NULL ORDER BY p."createdAt" LIMIT 2`, [ADMIN]));
  test.skip(waiting.rows.length < 1, "nothing is waiting for a place");

  await page.goto("/place");
  const tray = page.getByTestId("place-tray");
  await expect(tray).toBeVisible();
  // The map itself, drawn by MapLibre. Its tiles never load in here (no way out to the tile server) but the canvas
  // is real, which is all that placing needs: the map turns a point on the screen into a position on the ground.
  const map = page.locator(".maplibregl-canvas");
  await expect(map).toBeVisible({ timeout: 30_000 });

  // Tap one, then tap the map: the path that works on a phone and from a keyboard.
  await tray.locator(`button:has(img[src*='/api/photos/${waiting.rows[0].id}/'])`).click();
  const box = (await map.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("place-notice")).toContainText("placed");
  await expect
    .poll(async () => (await withDb((c) => c.query('SELECT lat, "gpsSource" FROM "Photo" WHERE id = $1', [waiting.rows[0].id]))).rows[0].gpsSource, { timeout: 20_000, intervals: [1000] })
    .toBe("MANUAL");
  const row = (await withDb((c) => c.query('SELECT lat, lng FROM "Photo" WHERE id = $1', [waiting.rows[0].id]))).rows[0];
  expect(Number(row.lat)).toBeGreaterThan(-90);
  expect(Number(row.lng)).toBeGreaterThan(-180);

  // And it leaves the list of things still waiting.
  await expect(tray.locator(`button:has(img[src*='/api/photos/${waiting.rows[0].id}/'])`)).toHaveCount(0);
});

test("a 3D scan is uploaded, kept whole, and shown in a viewer that can be turned", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/upload");
  await chooseFile(page, "scan.glb");
  await expect(page.getByText("1 of 1 uploaded.")).toBeVisible({ timeout: 30_000 });

  const scan = async () => (await withDb((c) => c.query('SELECT id, kind, "scanFormat", status, renditions, "sizeBytes" FROM "Photo" WHERE "originalName" = $1 ORDER BY "createdAt" DESC LIMIT 1', ["scan.glb"]))).rows[0];
  await expect.poll(async () => (await scan())?.status, { timeout: 30_000, intervals: [1000] }).toBe("READY");
  const row = await scan();
  expect(row.kind).toBe("SCAN");
  expect(row.scanFormat).toBe("GLB");
  // Kept exactly as it came: the file the album hands back is the file that was uploaded.
  const file = await page.request.get(`/api/photos/${row.id}/model`);
  expect(file.ok()).toBe(true);
  expect(file.headers()["content-type"]).toContain("model/gltf-binary");
  expect((await file.body()).length).toBe(Number(row.sizeBytes));

  // On its own page it is a viewer, not a broken image — and the first member to open it leaves a still behind,
  // which is the only way the album can ever have a tile for a shape it cannot draw itself.
  await page.goto(`/photos/${row.id}`);
  await expect(page.getByTestId("scan-viewer")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/3D scan \(GLB\)/)).toBeVisible();
  await expect
    .poll(async () => Boolean((await scan())?.renditions), { timeout: 40_000, intervals: [2000] })
    .toBe(true);

  // And the still is a picture of the scan, in the scan's own colours — not the blank rectangle a capture taken
  // before the browser has drawn anything produces, which comes out white on a phone and black on a desktop.
  const thumb = await page.request.get(`/api/photos/${row.id}/thumb`);
  expect(thumb.ok()).toBe(true);
  const { channels } = await sharp(Buffer.from(await thumb.body())).stats();
  expect(stillIsBlank(channels)).toBe(false);
  // And it is the scan's own colours, not the plain grey a mesh is drawn in when its texture never arrived — which
  // is what a policy that would not let the page read its own blobs used to produce.
  const [red, green, blue] = channels.map((c) => c.mean);
  expect(Math.max(Math.abs(red - green), Math.abs(green - blue))).toBeGreaterThan(3);

  // With a still taken, the grids show it like anything else, marked for what it is.
  await page.goto("/photos");
  const tile = page.locator("li.tile-lazy").filter({ has: page.locator(`img[src*='/api/photos/${row.id}/']`) });
  await expect(tile).toBeVisible();
  await expect(tile.getByText("3D")).toBeVisible();

  // And the helper is never shown a scan: there is no photograph in it to describe.
  await page.goto(`/photos/${row.id}`);
  await expect(page.getByText(/never sent to the helper/i)).toBeVisible();

  // A still that came out wrong is not permanent. Whoever may change the scan can throw it away, and the next
  // time the scan is looked at the viewer takes another — otherwise one bad tile would be the tile for good.
  await page.getByTestId("retake-still").click();
  await expect.poll(async () => (await scan())?.renditions, { timeout: 20_000, intervals: [500] }).toBeNull();
  await page.reload();
  await expect(page.getByTestId("scan-viewer")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => Boolean((await scan())?.renditions), { timeout: 40_000, intervals: [2000] })
    .toBe(true);
});

test("a whole selection is auto-colored in one go, and handed back in one press", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // Photographs of the admin's with nothing on them yet, so what the batch does to them is unambiguous.
  const plain = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "User" u ON u.id = p."uploaderId" WHERE p."tripId" = (SELECT id FROM "Trip" WHERE slug = 'acadia') AND p.kind = 'PHOTO' AND p.status = 'READY' AND p."trashedAt" IS NULL AND p.edits IS NULL AND u.email = $1 ORDER BY p."createdAt" LIMIT 3`, [ADMIN]));
  const picked = plain.rows.map((r: { id: string }) => r.id);
  test.skip(picked.length === 0, "no untouched photographs on the trip");

  await page.goto("/trips/acadia/photos");
  await page.getByRole("button", { name: "Select photos" }).click();
  for (const id of picked) await page.locator(`li.tile-lazy:has(img[src*='/api/photos/${id}/']) button[aria-pressed]`).first().click();

  await page.getByTestId("auto-color").click();
  await expect(page.getByRole("status")).toContainText("Auto color:");
  // The instruction is stored beside the picture; the file that was uploaded is not written over.
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" WHERE id = ANY($1) AND edits->>'auto' = 'true'`, [picked]))).rows[0].n, { timeout: 20_000, intervals: [1000] })
    .toBe(picked.length);

  // And the whole batch goes back with one press, leaving nothing behind on photographs that had nothing before.
  await page.getByTestId("undo-auto-color").click();
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" WHERE id = ANY($1) AND edits IS NOT NULL`, [picked]))).rows[0].n, { timeout: 20_000, intervals: [1000] })
    .toBe(0);
});

test("the uploader reaches the phone's own storage, and names what it will not take", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/upload");
  await page.waitForLoadState("networkidle");

  // The way in that a phone must not read as "open the photo app": narrowing this at all is what sent Android
  // members to Google Photos with no route to their downloads or a folder copied off a camera.
  const browse = page.locator("#photo-file-input");
  await expect(browse).toHaveCount(1);
  expect(await browse.getAttribute("accept")).toBeNull();
  await expect(page.getByRole("button", { name: "Browse files" })).toBeVisible();
  // And the short way round is still there for the usual case.
  await expect(page.locator("#photo-library-input")).toHaveAttribute("accept", "image/*,video/*");
  await expect(page.getByRole("button", { name: "Photos and videos" })).toBeVisible();

  // Because nothing narrows the chooser, a member can now pick anything — so anything unwanted is said out loud.
  await page.setInputFiles("#photo-file-input", { name: "tickets.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  await expect(page.getByRole("alert").getByText(/doesn't take \.pdf files/i)).toBeVisible();
});

test("a batch survives a dropped connection, and says out loud what did not go up", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/upload");
  await page.waitForLoadState("networkidle");

  // The phone locks its screen, or wifi hands over to the mobile network, and whatever was in the air is abandoned.
  // The browser fires neither load nor error for that, so an upload that does not handle it never finishes — and
  // the slot it holds is never given back. Three of those used to stop a long batch dead with no message anywhere.
  let dropped = 0;
  await page.route("**/api/upload", async (route) => {
    if (dropped < 2) {
      dropped += 1;
      return route.abort("connectionreset");
    }
    return route.fallback();
  });

  const six = ["photo-with-gps.jpg", "photo-no-gps.jpg", "photo-no-exif.jpg", "photo-with-gps.jpg", "photo-no-gps.jpg", "photo-no-exif.jpg"];
  await page.locator("#photo-file-input").first().setInputFiles(six.map((n) => fixture(n)));

  // Every one of them arrives, the two that were dropped having been tried again rather than abandoned.
  await expect(page.getByTestId("upload-progress")).toContainText("All 6 uploaded.", { timeout: 45_000 });
  expect(dropped).toBe(2);
  await expect(page.getByTestId("upload-failures")).toHaveCount(0);
});

test("a file the album will not take is named in the summary, with a way to try the rest again", async ({ context, page }) => {
  await signIn(context, ADMIN);
  await page.goto("/upload");
  await page.waitForLoadState("networkidle");

  // A refusal is final — sending it again would get the same answer — so it is said plainly rather than retried.
  await page.route("**/api/upload", (route) =>
    route.fulfill({ status: 415, contentType: "application/json", body: JSON.stringify({ error: "Unsupported file type: photo-no-exif.jpg" }) }),
  );
  await page.locator("#photo-file-input").first().setInputFiles(fixture("photo-no-exif.jpg"));

  const failures = page.getByTestId("upload-failures");
  await expect(failures).toBeVisible({ timeout: 60_000 });
  await expect(failures).toContainText("1 file did not go up");
  await expect(failures).toContainText("Unsupported file type");
  await expect(page.getByTestId("retry-failed")).toBeVisible();

  // And the way back: with the album taking them again, one press puts the failed ones back on the queue.
  await page.unroute("**/api/upload");
  await page.getByTestId("retry-failed").click();
  await expect(page.getByTestId("upload-progress")).toContainText("All 1 uploaded.", { timeout: 60_000 });
});

test("the overview shows a handful of the trip at random, and picks again when asked", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // Enough photographs on the trip that the same ten twice running would be a coincidence worth failing on. Earlier
  // tests upload them and processing is a background job, so this waits for them rather than skipping itself when
  // it happens to look early — a test that quietly stands down is a test that is not testing anything.
  const readyCount = async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" WHERE "tripId" = (SELECT id FROM "Trip" WHERE slug = 'acadia') AND status = 'READY' AND "trashedAt" IS NULL`))).rows[0].n;
  await expect.poll(readyCount, { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(10);

  const shown = async () => page.locator("li.tile-lazy img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src.match(/\/api\/photos\/([^/]+)\//)?.[1] ?? "").join(","));
  await page.goto("/trips/acadia/overview");
  await expect(page.getByRole("heading", { name: "A few from this trip" })).toBeVisible();
  const first = await shown();
  expect(first.split(",").filter(Boolean).length).toBeLessThanOrEqual(10);

  // Asking again gives a different handful; a shuffle that never moves is not a shuffle.
  await expect
    .poll(async () => {
      await page.getByTestId("show-another").click();
      await page.waitForTimeout(600);
      return (await shown()) !== first;
    }, { timeout: 30_000, intervals: [500] })
    .toBe(true);
});

test("a trip's photos can be searched and filtered, and paging keeps the narrowing", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // A caption nothing else has, so what comes back is unambiguous.
  const row = (await withDb((c) => c.query(`SELECT id FROM "Photo" WHERE "tripId" = (SELECT id FROM "Trip" WHERE slug = 'acadia') AND kind = 'PHOTO' AND status = 'READY' AND "trashedAt" IS NULL ORDER BY "createdAt" LIMIT 1`))).rows[0];
  await withDb((c) => c.query(`UPDATE "Photo" SET caption = $1 WHERE id = $2`, ["a puffin on the rocks", row.id]));

  await page.goto("/trips/acadia/photos");
  await page.getByPlaceholder("Search this trip").fill("puffin");
  await page.getByRole("button", { name: "Search" }).click();

  // The narrowed gallery is an ordinary address, so it can be kept or sent to somebody.
  await expect(page).toHaveURL(/q=puffin/);
  await expect(page.locator("li.tile-lazy")).toHaveCount(1);
  await expect(page.locator(`li.tile-lazy img[src*='/api/photos/${row.id}/']`)).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 })).toContainText("of");

  // A search with nothing behind it says so rather than looking like an empty album.
  await page.goto("/trips/acadia/photos?q=zzzznothing");
  await expect(page.getByTestId("no-matches")).toBeVisible();

  // Filtering by kind is the same mechanism; 3D scans are not photographs and drop out.
  await page.goto("/trips/acadia/photos?kind=SCAN");
  const scans = (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" WHERE "tripId" = (SELECT id FROM "Trip" WHERE slug = 'acadia') AND kind = 'SCAN' AND "trashedAt" IS NULL`))).rows[0].n;
  await expect(page.locator("li.tile-lazy")).toHaveCount(scans);

  // And clearing puts the whole trip back.
  await page.goto("/trips/acadia/photos?q=puffin");
  await page.getByTestId("clear-filters").click();
  await expect(page).toHaveURL(/\/trips\/acadia\/photos$/);
  await expect(page.locator("li.tile-lazy").first()).toBeVisible();
});

test("a photo in the trash stops being a cover, and stops looking out of the People page", async ({ context, page }) => {
  await signIn(context, ADMIN);
  const row = (await withDb((c) => c.query(`
    SELECT p.id, t.slug FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId"
    WHERE p.status = 'READY' AND p."trashedAt" IS NULL ORDER BY p."createdAt" LIMIT 1`))).rows[0];
  const coll = (await withDb((c) => c.query(`SELECT id, slug FROM "Collection" ORDER BY "createdAt" LIMIT 1`))).rows[0];

  // Chosen by hand as the cover of both, which is how a photograph goes on being the album's face after it is gone.
  await withDb((c) => c.query(`UPDATE "Trip" SET "coverPhotoId" = $1 WHERE slug = $2`, [row.id, row.slug]));
  if (coll) await withDb((c) => c.query(`UPDATE "Collection" SET "coverPhotoId" = $1 WHERE id = $2`, [row.id, coll.id]));

  await page.goto("/");
  await expect(page.locator(`img[src*='/api/photos/${row.id}/']`).first()).toBeVisible();

  await withDb((c) => c.query(`UPDATE "Photo" SET "trashedAt" = now(), "trashedById" = (SELECT id FROM "User" WHERE email = $1), "trashReason" = 'ACCIDENT' WHERE id = $2`, [ADMIN, row.id]));

  // Gone from the front page, and from the picture a link preview would draw — the album picks another itself.
  await page.goto("/");
  await expect(page.locator(`img[src*='/api/photos/${row.id}/']`)).toHaveCount(0);
  if (coll) {
    await page.goto(`/collections/${coll.slug}`);
    expect(await page.content()).not.toContain(row.id);
  }
  // And nowhere among the faces, where a trashed photograph used to go on looking out of the People page.
  await page.goto("/people");
  await expect(page.locator(`img[src*='/api/photos/${row.id}/']`)).toHaveCount(0);

  // Its own page still opens for whoever holds the link, and says plainly what happened to it.
  await page.goto(`/photos/${row.id}`);
  await expect(page.getByText("In the trash.")).toBeVisible();

  // Restoring puts the chosen cover back: nothing was thrown away to make it stop counting.
  await withDb((c) => c.query(`UPDATE "Photo" SET "trashedAt" = NULL, "trashedById" = NULL, "trashReason" = NULL WHERE id = $1`, [row.id]));
  await page.goto("/");
  await expect(page.locator(`img[src*='/api/photos/${row.id}/']`).first()).toBeVisible();

  await withDb((c) => c.query(`UPDATE "Trip" SET "coverPhotoId" = NULL WHERE slug = $1`, [row.slug]));
  if (coll) await withDb((c) => c.query(`UPDATE "Collection" SET "coverPhotoId" = NULL WHERE id = $1`, [coll.id]));
});

test("existing photographs are put on a trip by searching for them, by place and by nothing having claimed them", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // A photograph nothing has claimed: on no trip and in no collection, with a place written on it.
  const loose = (await withDb((c) => c.query(`
    SELECT p.id FROM "Photo" p
    WHERE p."tripId" IS NULL AND p.status = 'READY' AND p."trashedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."photoId" = p.id)
    ORDER BY p."createdAt" LIMIT 1`))).rows[0];
  test.skip(!loose, "nothing unclaimed to gather up");
  await withDb((c) => c.query(`UPDATE "Photo" SET "placeName" = $1, lat = 44.2223, lng = -68.3372 WHERE id = $2`, ["Bass Harbor Head Light", loose.id]));

  // The trip's gallery now offers a way in; trips had none before, uploads reached them only by date.
  await page.goto("/trips/acadia/photos");
  await page.getByRole("link", { name: "Add existing photos" }).click();
  await expect(page).toHaveURL(/\/trips\/acadia\/add$/);

  // The place a member wrote is searchable, which it was not before.
  await page.goto("/trips/acadia/add?q=Bass+Harbor");
  await expect(page.locator(`li:has(img[src*='/api/photos/${loose.id}/'])`)).toBeVisible();

  // So is a distance from a point: a mile of the lighthouse reaches it, a mile of Yosemite does not.
  await page.goto("/trips/acadia/add?lat=44.2223&lng=-68.3372&miles=1&place=Bass+Harbor+Head+Light");
  await expect(page.getByTestId("add-photos")).toContainText("within 1 mile of Bass Harbor Head Light");
  await expect(page.locator(`li:has(img[src*='/api/photos/${loose.id}/'])`)).toBeVisible();
  await page.goto("/trips/acadia/add?lat=37.8651&lng=-119.5383&miles=1");
  await expect(page.locator(`li:has(img[src*='/api/photos/${loose.id}/'])`)).toHaveCount(0);

  // And the check for the pile nothing has claimed, which is what the picker is mostly for.
  await page.goto("/trips/acadia/add?loose=1");
  await expect(page.getByTestId("add-photos")).toContainText("in no trip and no collection");
  const tile = page.locator(`li:has(img[src*='/api/photos/${loose.id}/'])`);
  await expect(tile).toBeVisible();
  await tile.locator("button").first().click();
  await page.getByTestId("picker-add").click();

  await expect(page).toHaveURL(/\/trips\/acadia\/photos\?added=1$/);
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT "tripId" FROM "Photo" WHERE id = $1`, [loose.id]))).rows[0].tripId, { timeout: 20_000, intervals: [500] })
    .not.toBeNull();
});

test("photographs are taken off a trip and out of a collection, and stay in the album", async ({ context, page }) => {
  await signIn(context, ADMIN);
  const onTrip = (await withDb((c) => c.query(`
    SELECT p.id FROM "Photo" p WHERE p."tripId" = (SELECT id FROM "Trip" WHERE slug = 'acadia')
      AND p.status = 'READY' AND p."trashedAt" IS NULL ORDER BY p."createdAt" DESC LIMIT 1`))).rows[0];

  // Taking something off a trip is one press, as taking it out of a collection already was.
  await page.goto("/trips/acadia/photos");
  await page.getByRole("button", { name: "Select photos" }).click();
  await page.locator(`li.tile-lazy:has(img[src*='/api/photos/${onTrip.id}/']) button[aria-pressed]`).first().click();
  await page.getByTestId("remove-from-trip").click();

  // It is off the trip but still in the album — nothing anyone uploaded is lost by tidying an arrangement of it.
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT "tripId", "trashedAt" FROM "Photo" WHERE id = $1`, [onTrip.id]))).rows[0], { timeout: 20_000, intervals: [500] })
    .toEqual({ tripId: null, trashedAt: null });
  await expect(page.getByRole("status")).toContainText("taken off this trip");
  await page.goto("/photos");
  // The grid loads its pictures as they come into view, so find the tile by its id and bring it into view first.
  const stillThere = page.locator(`li[data-photo-id="${onTrip.id}"]`);
  await stillThere.scrollIntoViewIfNeeded();
  await expect(stillThere.locator("img[src*='/api/photos/']")).toBeVisible();

  // And the same out of a collection, which now says what it did rather than leaving a shorter grid to explain it.
  const inCollection = (await withDb((c) => c.query(`
    SELECT ci."photoId" AS id, c.slug FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId"
    JOIN "Photo" p ON p.id = ci."photoId" WHERE p."trashedAt" IS NULL AND p.status = 'READY'
    ORDER BY c.slug, ci.position, ci."createdAt" LIMIT 1`))).rows[0];
  // Earlier tests put photographs into collections; if none is there, that is a failure to report, not to skip past.
  expect(inCollection, "no collection has anything in it").toBeTruthy();
  await page.goto(`/collections/${inCollection.slug}/photos`);
  await page.getByRole("button", { name: "Select photos" }).click();
  const tile = page.locator(`li[data-photo-id="${inCollection.id}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.locator("button[aria-pressed]").first().click();
  await page.getByTestId("remove-from-collection").click();
  await expect(page.getByRole("status")).toContainText("taken out of this collection");
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "CollectionItem" WHERE "photoId" = $1 AND "collectionId" = (SELECT id FROM "Collection" WHERE slug = $2)`, [inCollection.id, inCollection.slug]))).rows[0].n, { timeout: 20_000, intervals: [500] })
    .toBe(0);
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" WHERE id = $1 AND "trashedAt" IS NULL`, [inCollection.id]))).rows[0].n)
    .toBe(1);
});

test("the same file twice is one photograph, and the copies already in the album fold together", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // One particular file, sent twice. The first goes up; the second is the same bytes and must add nothing.
  const twice = Buffer.concat([fs.readFileSync(fixture("photo-with-gps.jpg")), Buffer.from("\n<!-- sent twice on purpose -->")]);
  const rows = async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Photo" WHERE "originalName" = $1`, ["twice.jpg"]))).rows[0].n;

  await page.goto("/upload");
  await chooseSameFile(page, "twice.jpg", twice);
  await expect.poll(rows, { timeout: 60_000, intervals: [500] }).toBe(1);

  await page.goto("/upload");
  await chooseSameFile(page, "twice.jpg", twice);
  await expect(page.getByTestId("already-here")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("already-here")).toContainText("already in the album");
  expect(await rows()).toBe(1);

  // For the copies an older album already collected, the admin page folds each set into one.
  const keeper = (await withDb((c) => c.query(`SELECT id FROM "Photo" WHERE "originalName" = $1`, ["twice.jpg"]))).rows[0];
  // A second row with the same bytes, as an album from before this would have ended up with.
  const copy = (await withDb((c) => c.query(
    `INSERT INTO "Photo" (id, "uploaderId", "originalName", "mimeType", "storageKey", "originalPath", "sizeBytes", status, "contentHash", caption, "createdAt", "updatedAt")
     SELECT 'dupe-' || substr(md5(random()::text), 1, 12), "uploaderId", 'copy.jpg', "mimeType", "storageKey", "originalPath", "sizeBytes", 'READY', "contentHash", 'A caption only the copy had', now(), now()
     FROM "Photo" WHERE id = $1 RETURNING id`, [keeper.id]))).rows[0];

  await page.goto("/admin");
  await expect(page.getByTestId("fold-duplicates")).toBeVisible();
  await page.getByTestId("fold-duplicates").click();
  await expect(page.getByRole("status")).toContainText("folded into", { timeout: 30_000 });

  // The copy is in the trash as a duplicate, and what only it knew is now on the one that was kept.
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT "trashedAt" IS NOT NULL AS gone, "trashReason" FROM "Photo" WHERE id = $1`, [copy.id]))).rows[0], { timeout: 20_000, intervals: [500] })
    .toEqual({ gone: true, trashReason: "DUPLICATE" });
  expect((await withDb((c) => c.query(`SELECT caption FROM "Photo" WHERE id = $1`, [keeper.id]))).rows[0].caption).toBe("A caption only the copy had");
});

test("a photograph says it is done as soon as it is done, while the rest are still going up", async ({ context, page }) => {
  test.setTimeout(180_000);
  await signIn(context, ADMIN);
  await withDb((c) => c.query(`DELETE FROM "Photo" WHERE "originalName" LIKE 'slow-%'`));
  await page.goto("/upload");
  await page.waitForLoadState("networkidle");

  // A phone on a slow connection, which is the only place this ever went wrong. Asking the album how the
  // processing was going used to be put off every time anything in the list changed, and a file crawling upwards
  // reports its progress continuously — so the question was never once asked until the whole batch had stopped
  // moving, and photographs finished half a minute earlier still said "Processing…". On a fast connection the
  // same fault costs half a second, which is why it never showed up here until it was measured throttled.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 5_000_000, uploadThroughput: 300_000 });

  const tag = randomUUID().slice(0, 8);
  const files = Array.from({ length: 4 }, (_, i) => ({
    name: `slow-${tag}-${i}.jpg`,
    mimeType: "image/jpeg",
    // The first is small and the rest are large on purpose. Sending them all has to take far longer than the wait
    // between asking, and the first one has to be finished and processed while the others are still climbing —
    // four of a size leaves that to chance, and a machine that processes slowly enough finishes the batch first.
    buffer: Buffer.concat([fs.readFileSync(fixture("photo-with-gps.jpg")), Buffer.alloc(i === 0 ? 150_000 : 3_000_000, i + 1), Buffer.from(`\n<!-- ${randomUUID()} -->`)]),
  }));
  const started = Date.now();
  await page.locator("#photo-file-input").setInputFiles(files);

  // Wait for the album itself to finish one of them, then for its tile to say so.
  const firstDone = async () => (await withDb((c) => c.query(`SELECT id FROM "Photo" WHERE "originalName" LIKE 'slow-' || $1 || '%' AND status = 'READY' ORDER BY "updatedAt" LIMIT 1`, [tag]))).rows[0]?.id ?? null;
  await expect.poll(firstDone, { timeout: 120_000, intervals: [200] }).not.toBeNull();
  const readyAt = Date.now();
  const id = await firstDone();

  await expect(page.locator(`img[src*='/api/photos/${id}/']`)).toBeVisible({ timeout: 30_000 });
  const lag = Date.now() - readyAt;

  // The point of the whole thing: it said so while the others were still going up, not after they had all landed.
  await expect(page.getByTestId("upload-progress")).not.toContainText("All 4 uploaded.");
  // And promptly — a couple of rounds of asking, not a couple of minutes.
  expect(lag, `tile lagged ${lag}ms behind the album finishing the photograph`).toBeLessThan(15_000);
  console.log(`[timing] ready at +${readyAt - started}ms, tile showed ${lag}ms later`);
});

test("the admin page says who has been looking, and tells a secret link from the family", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  await createTrip({ slug: "visitors", title: "Counted Trip", start: "2025-07-01", end: "2025-07-05", visibility: "LINK", shareToken: "counted-secret-token", ownerEmail: ADMIN });

  // A member reads the trip.
  await page.goto("/trips/visitors");
  await page.waitForLoadState("networkidle");

  // And somebody the link was sent to opens it, in a browser that has never signed in. A different page of the
  // trip on purpose: everything here comes from one address with one browser, so the same page within the minute
  // would rightly be counted as the same person looking twice.
  const stranger = await browser.newContext();
  const theirPage = await stranger.newPage();
  await theirPage.goto("/share/counted-secret-token/map");
  await theirPage.waitForLoadState("networkidle");
  await expect(theirPage.getByText("Shared with you")).toBeVisible();
  await theirPage.waitForLoadState("networkidle");
  await stranger.close();

  const counted = async () =>
    (await withDb((c) => c.query(`SELECT kind FROM "Visit" v JOIN "Trip" t ON t.id = v."tripId" WHERE t.slug = 'visitors'`))).rows.map((r) => r.kind).sort();
  await expect.poll(counted, { timeout: 20_000 }).toEqual(["MEMBER", "SHARE"]);

  // From here on nothing should be written down at all: reading the Admin page is administering the album,
  // not looking at it. ("Nothing with section 'other'" would not say that — plenty of ordinary pages are 'other'.)
  const before = (await withDb((c) => c.query("SELECT now() AS t"))).rows[0].t as Date;
  await page.goto("/admin?days=7#visitors");
  await expect(page.getByTestId("visitor-summary")).toContainText("by family signed in");
  const trip = page.locator("li", { hasText: "Counted Trip" }).first();
  await expect(trip).toContainText("1 on the secret link");
  // Every member is listed, whether or not they have read anything lately.
  await expect(page.getByTestId("visitor-members")).toContainText(ADMIN);

  // The window is the admin's to choose, and the choice survives the page.
  await page.getByRole("link", { name: "30 days" }).click();
  await expect(page).toHaveURL(/days=30/);
  await expect(page.getByTestId("visitor-summary")).toContainText("in the last 30 days");

  const since = await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Visit" WHERE at > $1`, [before]));
  expect(since.rows[0].n).toBe(0);
});

test("an unnamed group shows the faces themselves, and each one can be disowned or called a pet", async ({ context, page }) => {
  test.setTimeout(240_000);
  await signIn(context, ADMIN);
  await page.goto("/admin");
  await page.waitForLoadState("networkidle");
  const turnOn = page.getByRole("button", { name: "Turn on face detection" });
  if (await turnOn.count()) await turnOn.click();
  await expect(page.getByText("scanning new photos")).toBeVisible();

  // Start from nothing, so the groups on the page are the ones this test made. The photograph matters: the album
  // recognises whoever has been named already, and a fixture somebody else's test has named arrives proposed
  // rather than unnamed — this one is nobody, so it lands in a group waiting for a name.
  await withDb((c) => c.query('DELETE FROM "Face"'));
  await withDb((c) => c.query('DELETE FROM "FaceCluster" WHERE "personId" IS NULL'));
  // Count faces on this test's own photographs only. The sweep is meanwhile working through whatever earlier tests
  // uploaded, so however clean the table is made first, a count of the whole of it is somebody else's arithmetic.
  const uploaded: string[] = [];
  const uploadOne = async (faces: number) => {
    await page.goto("/upload");
    await chooseFile(page, "photo-no-exif.jpg");
    await expect(page.locator("img[src*='/api/photos/']")).toBeVisible({ timeout: 30_000 });
    const mineNow = (await withDb((c) => c.query(`SELECT id FROM "Photo" ORDER BY "createdAt" DESC LIMIT 1`))).rows[0].id as string;
    if (!uploaded.includes(mineNow)) uploaded.push(mineNow);
    await expect
      .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Face" WHERE status = 'DETECTED' AND "photoId" = ANY($1)`, [uploaded]))).rows[0].n, { timeout: 60_000, intervals: [1000] })
      .toBe(faces);
  };
  // The same face twice: one group of two, which is what a family disowning one of them actually has.
  await uploadOne(1);
  await uploadOne(2);

  // Address this group by its id throughout: the sweep quietly scans whatever else earlier tests uploaded, so
  // "the first group on the page" and "how many groups there are" are both somebody else's business.
  const groupId = (await withDb((c) => c.query(`SELECT "clusterId" AS id FROM "Face" WHERE status = 'DETECTED' AND "photoId" = ANY($1) LIMIT 1`, [uploaded]))).rows[0].id;
  const mine = (await withDb((c) => c.query(`SELECT id FROM "Face" WHERE "clusterId" = $1 AND status = 'DETECTED'`, [groupId]))).rows.map((r) => r.id as string);
  expect(mine).toHaveLength(2);

  await page.goto("/people");
  const card = page.locator(`[data-cluster="${groupId}"]`);
  await expect(card.getByText("2 faces that look alike")).toBeVisible();

  // The faces are actually drawn. They used to be grey circles: the picture was positioned against its own width
  // rather than the circle's, which threw the crop clean outside, so each circle showed its own empty background.
  const thumb = card.locator("img").first();
  await expect(thumb).toBeVisible();
  const drawn = await thumb.evaluate((img: HTMLImageElement) => {
    const circle = img.parentElement!.getBoundingClientRect();
    const picture = img.getBoundingClientRect();
    return {
      loaded: img.naturalWidth > 0,
      // The picture has to cover the circle on every side, or part of the circle is showing nothing.
      covers: picture.left <= circle.left + 0.5 && picture.top <= circle.top + 0.5 && picture.right >= circle.right - 0.5 && picture.bottom >= circle.bottom - 0.5,
    };
  });
  expect(drawn.loaded, "the face crop's picture never loaded").toBe(true);
  expect(drawn.covers, "the picture does not cover the circle, so the circle is showing its own background").toBe(true);

  // "That one is not them": among relatives who look alike, the cousin leaves the group and waits on her own.
  await card.getByRole("button", { name: "not them" }).nth(1).click();
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Face" WHERE "clusterId" = $1`, [groupId]))).rows[0].n, { timeout: 15_000 })
    .toBe(1);
  const moved = await withDb((c) => c.query(`SELECT id, status, "clusterId" FROM "Face" WHERE id = ANY($1) AND "clusterId" IS DISTINCT FROM $2`, [mine, groupId]));
  expect(moved.rows).toHaveLength(1);
  // It is still a face waiting for a name, in a group of its own.
  expect(moved.rows[0].status).toBe("DETECTED");
  expect(moved.rows[0].clusterId).not.toBeNull();

  // "That is not a face at all": a statue keeps its row, without a template, so a re-scan knows the spot.
  await page.goto("/people");
  await page.locator(`[data-cluster="${groupId}"]`).getByRole("button", { name: "not a face" }).first().click();
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Face" WHERE id = ANY($1) AND status = 'NOT_A_FACE' AND embedding IS NULL AND "clusterId" IS NULL`, [mine]))).rows[0].n, { timeout: 15_000 })
    .toBe(1);

  // A group that is really the family's dog is named as the dog.
  await page.goto("/people");
  await page.locator("#pet-name").fill("Rufus");
  await page.locator("#pet-species").selectOption("DOG");
  await page.getByRole("button", { name: "Add pet" }).click();
  await expect(page.getByRole("link", { name: /Rufus/ })).toBeVisible();

  const leftOver = (await withDb((c) => c.query(`SELECT "clusterId" AS id FROM "Face" WHERE id = ANY($1) AND status = 'DETECTED'`, [mine]))).rows[0].id;
  const forPet = page.locator(`[data-cluster="${leftOver}"]`);
  await forPet.getByLabel("Someone already named?").selectOption({ label: "Rufus" });
  await expect(forPet.getByText(/spotted by the animal detector/)).toBeVisible();
  await forPet.getByRole("button", { name: "Name these faces" }).click();
  const rufus = await withDb((c) => c.query(`SELECT id FROM "Person" WHERE name = 'Rufus'`));
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Face" WHERE "personId" = $1 AND status = 'CONFIRMED'`, [rufus.rows[0].id]))).rows[0].n, { timeout: 15_000 })
    .toBeGreaterThan(0);
  // A dog is spotted by the animal detector, never by face, so no template is kept for it.
  expect((await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Face" WHERE "personId" = $1 AND embedding IS NOT NULL`, [rufus.rows[0].id]))).rows[0].n).toBe(0);
});

test("somebody the album missed is tagged by pointing at them, and can agree to be named in descriptions", async ({ context, page }) => {
  test.setTimeout(180_000);
  await signIn(context, ADMIN);
  const photo = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p.kind = 'PHOTO' AND p.status = 'READY' ORDER BY p."createdAt" LIMIT 1`));
  const photoId = photo.rows[0].id as string;
  await page.goto(`/photos/${photoId}`);
  await page.waitForLoadState("networkidle");

  // Point at somebody in the picture and say who they are: the detector never found this one.
  await page.getByTestId("tag-someone").click();
  const surface = page.getByTestId("photo-tag-surface");
  const box = (await surface.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.35);
  await page.getByLabel("Their name").fill("Great-Aunt Vi");
  await page.getByRole("button", { name: "Tag", exact: true }).click();
  await expect(page.getByTestId("photo-tag").filter({ hasText: "Great-Aunt Vi" })).toBeVisible();

  const tag = await withDb((c) => c.query(`SELECT f.id, f.box, f.confidence, f.status, f."clusterId", p.id AS "personId", p."nameInDescriptions" FROM "Face" f JOIN "Person" p ON p.id = f."personId" WHERE f."photoId" = $1 AND p.name = 'Great-Aunt Vi'`, [photoId]));
  expect(tag.rows).toHaveLength(1);
  // A tag is a caption with a position: no template, no group, nothing recognised from it.
  expect(tag.rows[0]).toMatchObject({ status: "CONFIRMED", confidence: 0, clusterId: null, nameInDescriptions: false });
  expect(Number(tag.rows[0].box[0])).toBeGreaterThan(0.2);
  const templates = await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Face" WHERE id = $1 AND embedding IS NOT NULL`, [tag.rows[0].id]));
  expect(templates.rows[0].n).toBe(0);

  // Being named in the descriptions is its own decision, and an admin records it on the person's page.
  const personId = tag.rows[0].personId as string;
  await withDb((c) => c.query(`UPDATE "Person" SET birthday = '1938-04-02' WHERE id = $1`, [personId]));
  await page.goto(`/people/${personId}`);
  await page.getByTestId("name-in-descriptions").click();
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT "nameInDescriptions" FROM "Person" WHERE id = $1`, [personId]))).rows[0].nameInDescriptions, { timeout: 15_000 })
    .toBe(true);

  // Which is what puts the item in the "describe again, now that people are named" run.
  await withDb((c) => c.query(`UPDATE "Photo" SET "annotatedAt" = now() - interval '1 day' WHERE id = $1`, [photoId]));
  await page.goto("/admin");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("What to ask for").selectOption("names");
  await page.getByRole("button", { name: "Estimate" }).click();
  const status = page.getByRole("status").first();
  await expect(status).toContainText("would be sent");
  expect(Number((await status.textContent())!.match(/(\d+) items? would be sent/)![1])).toBeGreaterThan(0);

  // And the tag comes off again.
  await page.goto(`/photos/${photoId}`);
  await page.getByTestId("tag-someone").click();
  await page.getByRole("button", { name: "Remove the tag for Great-Aunt Vi" }).click();
  await expect
    .poll(async () => (await withDb((c) => c.query(`SELECT count(*)::int AS n FROM "Face" WHERE "photoId" = $1 AND "personId" = $2`, [photoId, personId]))).rows[0].n, { timeout: 15_000 })
    .toBe(0);
});

test("the timeline shows every day at once, with a panel down the side to reach any of them", async ({ context, page }) => {
  test.setTimeout(180_000);
  await signIn(context, ADMIN);
  // Spread the trip's photographs over months, so the timeline is long enough to need navigating.
  const trip = await withDb((c) => c.query(`SELECT id FROM "Trip" WHERE slug = 'acadia'`));
  const ids = await withDb((c) => c.query(`SELECT id FROM "Photo" WHERE "tripId" = $1 AND status = 'READY' AND "trashedAt" IS NULL ORDER BY "createdAt" LIMIT 6`, [trip.rows[0].id]));
  expect(ids.rows.length).toBeGreaterThan(2);
  for (const [i, row] of ids.rows.entries()) {
    // Off any activity as well: a photograph filed on one is shown inside that activity's card, under the
    // activity's day rather than its own, so re-dating it alone would not give the timeline a new day.
    await withDb((c) => c.query(`UPDATE "Photo" SET "takenAt" = $2, "takenAtSource" = 'EXIF_OFFSET', "tzOffsetMin" = 0, "activityId" = NULL WHERE id = $1`, [row.id, new Date(Date.UTC(2025, 5 + i, 3 + i, 12))]));
  }

  await page.goto("/trips/acadia");
  await page.waitForLoadState("networkidle");

  // Every day the trip holds is on the page: no cursor in the address, and nothing offering a later page.
  const days = page.locator("section[id^='day-']");
  await expect.poll(async () => days.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(ids.rows.length);
  await expect(page.getByRole("link", { name: /Later days/ })).toHaveCount(0);
  expect(page.url()).not.toContain("after=");

  // The panel lists the same days, gathered by month, and says how much the whole thing holds.
  const nav = page.getByTestId("timeline-nav");
  await expect(nav).toBeVisible();
  await expect(nav).toContainText(/\d+ photos over \d+ days/);
  expect(await nav.locator("a[data-day]").count()).toBe(await days.count());

  // Pressing a day in the panel goes to it, and the panel marks where you are.
  const last = nav.locator("a[data-day]").last();
  const target = (await last.getAttribute("data-day"))!;
  await last.click();
  await expect(page.locator(`#${target}`)).toBeInViewport({ timeout: 10_000 });
  await expect.poll(async () => nav.locator(`a[data-day="${target}"][aria-current="true"]`).count(), { timeout: 10_000 }).toBe(1);

  // A month folds away without taking its neighbours with it.
  const months = nav.locator("button[aria-expanded]");
  const before = await nav.locator("a[data-day]").count();
  await months.first().click();
  await expect.poll(async () => nav.locator("a[data-day]").count()).toBeLessThan(before);
});

test("a search can ask for a particular person or pet, and the rest of the questions wait behind a fold", async ({ browser, context, page }) => {
  await signIn(context, ADMIN);
  // Somebody on exactly one of this trip's photographs. A tag is a face with a box and no confidence, which is the
  // same thing to a search as a name the detector's find was confirmed with.
  const two = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p.status = 'READY' AND p."trashedAt" IS NULL ORDER BY p.id LIMIT 2`));
  expect(two.rows.length).toBe(2);
  const [photoId, otherId] = two.rows.map((r) => r.id as string);
  const admin = await withDb((c) => c.query(`SELECT id FROM "User" WHERE email = $1`, [ADMIN]));
  const personId = randomUUID();
  const alsoId = randomUUID();
  const tag = async (person: string, photo: string) =>
    withDb((c) => c.query(`INSERT INTO "Face" (id, "photoId", "personId", status, box, confidence, "createdAt") VALUES ($1, $2, $3, 'CONFIRMED', '{"x":0.1,"y":0.1,"w":0.2,"h":0.2}'::jsonb, 0, now())`, [randomUUID(), photo, person]));
  await withDb((c) => c.query(`INSERT INTO "Person" (id, kind, name, "createdById", "createdAt", "updatedAt") VALUES ($1, 'PET', $2, $3, now(), now())`, [personId, `Biscuit ${personId.slice(0, 4)}`, admin.rows[0].id]));
  await withDb((c) => c.query(`INSERT INTO "Person" (id, kind, name, "createdById", "createdAt", "updatedAt") VALUES ($1, 'HUMAN', $2, $3, now(), now())`, [alsoId, `Ada ${alsoId.slice(0, 4)}`, admin.rows[0].id]));
  // The pet is on one photograph; the person is on that one and on a second, so "both" is narrower than "either".
  await tag(personId, photoId);
  await tag(alsoId, photoId);
  await tag(alsoId, otherId);

  await page.goto("/trips/acadia");
  // The words are all the form shows to begin with; everything else waits behind the fold.
  const more = page.getByTestId("advanced-filters");
  await expect(more).toBeVisible();
  await expect(page.getByTestId("who-filter")).toBeHidden();
  await more.getByText("More ways to narrow").click();
  await expect(page.getByTestId("who-filter")).toBeVisible();
  // And what the uploader box is choosing is said out loud rather than left as a bare "Anyone".
  await expect(more.getByText("Uploaded by")).toBeVisible();

  // The pet is offered under its own heading, and asking for it gives exactly the one photograph it is on.
  await page.getByTestId("who-filter").selectOption(personId);
  await page.getByTestId("advanced-filters").getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(new RegExp(`person=${personId}`));
  await expect(page.getByTestId("timeline-count")).toContainText(/1 of \d+ items/);
  await expect(page.locator(`li.tile-lazy:has(img[src*='/api/photos/${photoId}/'])`)).toHaveCount(1);
  // Arriving at a narrowed link shows why it is narrowed rather than hiding the reason behind the fold.
  await expect(page.getByTestId("who-filter")).toBeVisible();

  // The person alone is on two of them.
  await page.goto(`/trips/acadia?person=${alsoId}`);
  await expect(page.getByTestId("timeline-count")).toContainText(/2 of \d+ items/);

  // Both at once means the ones they are both in, not either of them: back to the single photograph they share.
  await page.getByTestId("who-filter").selectOption([personId, alsoId]);
  await page.getByTestId("advanced-filters").getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(new RegExp(`person=${personId}[^]*person=${alsoId}|person=${alsoId}[^]*person=${personId}`));
  await expect(page.getByTestId("timeline-count")).toContainText(/1 of \d+ items/);
  await expect(page.locator(`li.tile-lazy:has(img[src*='/api/photos/${photoId}/'])`)).toHaveCount(1);
  // Both are still shown as chosen, so the page says what it was asked.
  expect(await page.getByTestId("who-filter").evaluate((el) => [...(el as HTMLSelectElement).selectedOptions].length)).toBe(2);

  // The same question on the album-wide search, which reaches every trip.
  await page.goto(`/search?q=&person=${personId}`);
  await expect(page.getByTestId("who-filter")).toBeVisible();

  // A visitor who is not family can neither see the question nor ask it by hand.
  await setVisibility("acadia", "PUBLIC");
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/trips/acadia?person=${personId}`);
  await expect(anonPage.getByTestId("who-filter")).toHaveCount(0);
  // Unnarrowed: the whole trip is there, not the one photograph the person is on.
  await expect(anonPage.locator("section[id^='day-']").first()).toBeVisible();
  expect(await anonPage.locator("li.tile-lazy").count()).toBeGreaterThan(1);
  await anon.close();
  await setVisibility("acadia", "PRIVATE");

  await withDb((c) => c.query(`DELETE FROM "Face" WHERE "personId" = ANY($1)`, [[personId, alsoId]]));
  await withDb((c) => c.query(`DELETE FROM "Person" WHERE id = ANY($1)`, [[personId, alsoId]]));
});

test("the map can be asked where something was, and shows only those places", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // A photograph of this trip that has a place on it, given a word of its own to be found by.
  const placed = await withDb((c) => c.query(`SELECT p.id FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p.status = 'READY' AND p."trashedAt" IS NULL AND p.lat IS NOT NULL ORDER BY p.id LIMIT 1`));
  expect(placed.rows.length).toBe(1);
  const id = placed.rows[0].id as string;
  await withDb((c) => c.query(`UPDATE "Photo" SET caption = 'thunderhole qqx' WHERE id = $1`, [id]));

  await page.goto("/trips/acadia/map");
  await expect(page.getByTestId("map-count")).toBeVisible();
  const all = Number((await page.getByTestId("map-count").textContent())!.match(/(\d+) photo/)![1]);
  expect(all).toBeGreaterThan(1);

  await page.getByPlaceholder("Search this trip").fill("thunderhole qqx");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=thunderhole/);
  // Only where that one was taken, and the tracks go with it: a narrowed map is the matches and nothing else.
  await expect(page.getByTestId("map-count")).toHaveText(/0 tracks · 1 photo$/);

  // A question with no answer says it is a question with no answer, not that nothing has been placed.
  await page.goto("/trips/acadia/map?q=qqzznothingatall");
  await expect(page.getByTestId("map-no-matches")).toBeVisible();

  // And the same question on the album-wide map, where it reaches every trip.
  await page.goto("/map?q=thunderhole+qqx");
  await expect(page.getByTestId("map-count")).toHaveText(/0 tracks · 1 photo$/);

  await withDb((c) => c.query(`UPDATE "Photo" SET caption = NULL WHERE id = $1`, [id]));
});

test("a trip opens on its timeline, which can be asked for one photograph and still shows the day around it", async ({ context, page }) => {
  await signIn(context, ADMIN);

  // The trip's own address is the timeline now: the days, not a summary.
  await page.goto("/trips/acadia");
  await expect(page.getByTestId("timeline-nav")).toBeVisible();
  await expect(page.locator("section[id^='day-']").first()).toBeVisible();
  // The tab for it is the first one and is the one marked, and what shapes the trip is at the far end.
  const tabs = page.getByTestId("trip-tabs").locator("li a");
  const labels = await tabs.allInnerTexts();
  expect(labels[0]).toBe("Timeline");
  expect(labels.indexOf("Photos")).toBeGreaterThan(labels.indexOf("Map"));
  expect(labels.indexOf("Overview")).toBeGreaterThan(labels.indexOf("Photos"));
  expect(labels[labels.length - 1]).toBe("Settings");

  // The address it used to live at still works, so a link somebody kept goes on working.
  await page.goto("/trips/acadia/timeline");
  await expect(page).toHaveURL(/\/trips\/acadia$/);

  // Give one photograph on the trip a word of its own to be found by.
  const mine = await withDb((c) => c.query(`SELECT p.id, p."takenAt" FROM "Photo" p JOIN "Trip" t ON t.id = p."tripId" WHERE t.slug = 'acadia' AND p.status = 'READY' AND p."trashedAt" IS NULL AND p."takenAt" IS NOT NULL ORDER BY p."takenAt" LIMIT 1`));
  const id = mine.rows[0].id as string;
  await withDb((c) => c.query(`UPDATE "Photo" SET caption = 'thunderhole zzq' WHERE id = $1`, [id]));

  await page.goto("/trips/acadia");
  const before = await page.locator("section[id^='day-']").count();
  await page.getByPlaceholder("Search this trip").fill("thunderhole zzq");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=thunderhole/);
  // Narrowed in place: the one that matches, still under the day it was taken.
  await expect(page.getByTestId("timeline-count")).toContainText(/1 of \d+ items/);
  await expect(page.locator("section[id^='day-']")).toHaveCount(1);
  expect(before).toBeGreaterThan(1);
  await expect(page.locator(`li.tile-lazy:has(img[src*='/api/photos/${id}/'])`)).toHaveCount(1);

  // A whole day can be picked up from a heading, on a gathering as well as on a trip. This is a control that asks
  // the selection for its state and renders nothing at all when there is none, so a page that forgot to offer one
  // lost every "Select this day" on it without a word.
  for (const where of ["/trips/acadia", "/collections/best-of-2025"]) {
    await page.goto(where);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Select photos" }).click();
    const day = page.getByTestId("day-select").first();
    await expect(day).toHaveText("Select this day");
    await day.click();
    await expect(day).toHaveText("Clear");
    await expect(page.getByText(/\d+ selected/).first()).toBeVisible();
  }

  // And a question with no answer says so rather than showing an empty timeline.
  await page.goto("/trips/acadia?q=qqzzxnothing");
  await expect(page.getByTestId("no-matches")).toBeVisible();
  await page.getByTestId("clear-filters").click();
  await expect(page).toHaveURL(/\/trips\/acadia$/);
  await withDb((c) => c.query(`UPDATE "Photo" SET caption = NULL WHERE id = $1`, [id]));
});

test("on a phone the day heading itself opens the whole timeline to choose from", async ({ context, page }) => {
  await signIn(context, ADMIN);
  // A phone, where there is no room for the panel beside the path — and the heading is the only thing always on screen.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/trips/acadia");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("timeline-nav")).toBeHidden();

  await page.getByTestId("day-jump").first().click();
  const sheet = page.getByTestId("day-jump-sheet");
  await expect(sheet).toBeVisible();
  // Every day is offered, and the one being read is marked.
  const days = page.locator("section[id^='day-']");
  expect(await sheet.locator("[data-day-jump]").count()).toBe(await days.count());
  await expect(sheet.locator('[data-day-jump][aria-current="true"]')).toHaveCount(1);

  const last = sheet.locator("[data-day-jump]").last();
  const target = (await last.getAttribute("data-day-jump"))!;
  await last.click();
  await expect(sheet).toBeHidden();
  await expect(page.locator(`#${target}`)).toBeInViewport({ timeout: 10_000 });
});
