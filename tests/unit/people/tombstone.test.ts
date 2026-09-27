import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { annotationSchema } from "@/lib/annotation/schema";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "ADMIN" as "MEMBER" | "ADMIN", id: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
const queued = vi.hoisted(() => ({ jobs: [] as unknown[] }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async (...args: unknown[]) => void queued.jobs.push(args) }));

import { allowForgottenName, allowForgottenNameTyped, optOutPerson } from "@/app/people/actions";
import { applyAnnotation } from "@/lib/annotation/apply";
import { applyPlaceEstimate } from "@/lib/annotation/place";
import { loadItem, withoutUnpermittedNames } from "@/lib/annotation/request";
import { withoutUnpermittedNames as withoutContainerNames } from "@/lib/annotation/container";
import { forgetKeyState, forgottenHashesOf, forgottenNameLabel, forgottenNames, forgottenScope, hashedPhotoId, hashPlainScopes, loadTombstone } from "@/lib/people/tombstone";
import { completePendingForgets } from "@/lib/people/forget-person";
import { withForgetLock } from "@/lib/people/names-changed";
import { nameMatcher } from "@/lib/people/scrub";
import { Client } from "pg";

const record = (over: Partial<StoredAnnotation> & Record<string, unknown> = {}) =>
  annotationSchema.parse({ title: "At the lake", caption: "A day at the lake", description: "Swimming.", tags: ["lake"], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "lake", estimatedYear: null, estimatedPlace: null, ...over });

describe("a forgotten name, after the person's record is gone", () => {
  let admin: string, timothy: string, trip: string, photoId: string;
  const forget = async () => {
    const fd = new FormData();
    await optOutPerson(timothy, fd);
  };

  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    timothy = (await db.person.create({ data: { name: "Timothy Kent", createdById: admin } })).id;
    trip = (await db.trip.create({ data: { slug: "bday", title: "Timothy Kent's 5th birthday", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } })).id;
    // Never tagged: only the family's own words say who is in it.
    photoId = (await db.photo.create({ data: { uploaderId: admin, originalName: "t.jpg", mimeType: "image/jpeg", storageKey: "t", originalPath: "t/o.jpg", sizeBytes: 1, status: "READY", tripId: trip, title: "Timothy Kent's retirement", caption: "Timothy Kent by the river", context: "Timothy Kent fishing" } })).id;
  });

  it("is never handed to the helper again, in a title, caption, notes or trip title", async () => {
    await forget();
    expect(await db.person.findUnique({ where: { id: timothy } })).toBeNull();
    const safe = await withoutUnpermittedNames((await loadItem(photoId))!);
    expect(safe).toMatchObject({ title: "A family member's retirement", caption: "A family member by the river", context: "A family member fishing" });
    expect(safe.trip?.title).toBe("A family member's 5th birthday");
    const c = await withoutContainerNames({ title: "Timothy Kent's 5th birthday", activities: ["Timothy Kent's walk"], description: "Timothy Kent turned five.", descriptionByHelper: false, photos: [{ id: photoId, title: null, titleByHelper: false, annotation: null, caption: "Timothy Kent by the river", context: "Timothy Kent fishing" }] });
    expect(c.title).toBe("A family member's 5th birthday");
    expect(c.activities).toEqual(["A family member's walk"]);
    expect(c.description).toBe("A family member turned five.");
    expect(c.photos[0]).toMatchObject({ caption: "A family member by the river", context: "A family member fishing" });
  });

  it("is not stored from an answer that was on its way when they were forgotten", async () => {
    const before = new Date(Date.now() - 60_000);
    await forget();
    await applyAnnotation(photoId, "m", record({ title: "Timothy Kent fishing", caption: "Timothy Kent with a trout" }), { content: [] }, { requestedAt: before });
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.annotation).toBeNull();
    expect(p.annotationError).toBe("names_changed");
    expect(await db.mediaAnnotationRaw.count({ where: { photoId } })).toBe(0);
    expect(await applyPlaceEstimate(photoId, { name: "Kent's river", precision: "exact", lat: 44, lng: -68, radiusM: 100, confidence: 0.9, evidence: "the sign" }, { requestedAt: before })).toBe("stale");
  });

  it("is taken out of a new answer, even on a photograph they were never tagged on", async () => {
    await forget();
    await applyAnnotation(photoId, "m", record({ title: "Timothy Kent fishing", caption: "Timothy Kent with a trout", tags: ["timothy kent", "trout"], searchSummary: "timothy kent trout" }), { content: [] }, { requestedAt: new Date() });
    const a = (await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotation as StoredAnnotation;
    expect(a).toMatchObject({ title: "A family member fishing", caption: "A family member with a trout", tags: ["trout"], searchSummary: "A family member trout" });
  });

  it("stays somebody else's when somebody the album knows now has it", async () => {
    await forget();
    await db.person.create({ data: { name: "Timothy Kent", createdById: admin } });
    expect((await loadTombstone()).scrub("Timothy Kent waves")).toBe("Timothy Kent waves");
  });

  it("keeps nothing of the name itself", async () => {
    await forget();
    const rows = await db.forgottenName.findMany();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/timothy|kent/i);
  });

  it("is thrown away while a forget is under way, and kept when none has happened since it was asked for", async () => {
    const before = new Date(Date.now() - 60_000);
    const other = (await db.photo.create({ data: { uploaderId: admin, originalName: "o.jpg", mimeType: "image/jpeg", storageKey: "o", originalPath: "o/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    // A forget still running: nothing is stored, and the item is asked about again.
    queued.jobs = [];
    await withForgetLock(async () => {
      await applyAnnotation(other, "m", record(), { content: [] }, { requestedAt: before });
    });
    expect((await db.photo.findUniqueOrThrow({ where: { id: other } })).annotationError).toBe("names_changed");
    expect(queued.jobs.length).toBeGreaterThan(0);
    // Once it has finished, an answer about a photograph it never touched is kept.
    await applyAnnotation(other, "m", record(), { content: [] }, { requestedAt: before });
    expect((await db.photo.findUniqueOrThrow({ where: { id: other } })).annotation).not.toBeNull();
  });

  it("is not stored from an answer asked for just before the record was finally deleted", async () => {
    // Asked for after the scrub, but while the person's record (and so their name) was still somebody's.
    await forget();
    const settled = (await db.appSetting.findUniqueOrThrow({ where: { id: "app" } })).lastForgetAt!;
    await applyAnnotation(photoId, "m", record({ title: "Timothy Kent's day" }), { content: [] }, { requestedAt: new Date(settled.getTime() - 1) });
    expect((await db.photo.findUniqueOrThrow({ where: { id: photoId } })).annotationError).toBe("names_changed");
  });

  it("takes the name out of what the helper wrote on a photograph whose members' words name them, stamping nothing", async () => {
    await db.photo.update({ where: { id: photoId }, data: { annotation: record({ caption: "Timothy by the river", description: "Timothy Kent casts a line." }), annotatedAt: new Date() } });
    await forget();
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    // Which photographs a forget covered is not written on them (see forgetState).
    expect(p.namesScrubbedAt).toBeNull();
    expect((p.annotation as StoredAnnotation).description).toBe("A family member casts a line.");
  });

  it("leaves a backfill's photograph for the next backfill when only a forget since spoiled its answer", async () => {
    const before = new Date(Date.now() - 60_000);
    const other = (await db.photo.create({ data: { uploaderId: admin, originalName: "o.jpg", mimeType: "image/jpeg", storageKey: "o", originalPath: "o/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    await forget();
    queued.jobs = [];
    await applyAnnotation(other, "m", record(), { content: [], batched: true }, { requestedAt: before });
    // Not stored, not a terminal failure (still eligible for a backfill), and not asked again one by one at full price.
    expect(await db.photo.findUniqueOrThrow({ where: { id: other } })).toMatchObject({ annotation: null, annotatedAt: null, annotationError: "batch:names_changed" });
    expect(queued.jobs).toEqual([]);
    // One asked for on its own is asked again, as before.
    await applyAnnotation(other, "m", record(), { content: [] }, { requestedAt: before });
    expect(queued.jobs.length).toBeGreaterThan(0);
  });

  it("deletes only the raw answers on its photographs that name them", async () => {
    await db.photo.update({ where: { id: photoId }, data: { annotation: record({ caption: "Timothy Kent fishing" }), annotatedAt: new Date() } });
    await db.mediaAnnotationRaw.create({ data: { photoId, model: "m", response: { content: [{ type: "text", text: "Timothy Kent fishing" }] } } });
    const quiet = await db.mediaAnnotationRaw.create({ data: { photoId, model: "m", response: { content: [{ type: "text", text: "A river at dawn" }] } } });
    await forget();
    expect((await db.mediaAnnotationRaw.findMany({ where: { photoId } })).map((r) => r.id)).toEqual([quiet.id]);
  });

  it("remembers a name holding a colon with a space for it, never as a place's or title's key", async () => {
    const p = await db.person.create({ data: { name: "photo:abc", createdById: admin } });
    await optOutPerson(p.id, new FormData());
    const rows = await db.forgottenName.findMany({ where: { derived: false } });
    const hashes = rows.map((r) => r.hash);
    // Remembered, as "photo abc" (forgotten, the name is looked for as the two words)...
    const spaced = await forgottenHashesOf("photo abc");
    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.every((h) => spaced.includes(h))).toBe(true);
    // ...and never under the key a photograph "abc" is hashed by.
    for (const r of rows) expect(hashes).not.toContain(await hashedPhotoId("abc", r.keyVersion));
  });

  it("throws away an answer asked for before a forget, whatever photograph it is about", async () => {
    const before = new Date(Date.now() - 60_000);
    const other = (await db.photo.create({ data: { uploaderId: admin, originalName: "o.jpg", mimeType: "image/jpeg", storageKey: "o", originalPath: "o/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    await forget();
    await applyAnnotation(other, "m", record(), { content: [] }, { requestedAt: before });
    expect((await db.photo.findUniqueOrThrow({ where: { id: other } })).annotationError).toBe("names_changed");
    await applyAnnotation(other, "m", record(), { content: [] }, { requestedAt: new Date() });
    expect((await db.photo.findUniqueOrThrow({ where: { id: other } })).annotation).not.toBeNull();
  });
});

describe("forgotten names read before a forget", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
  });

  it("are read again before an answer is stored", async () => {
    const ts = await loadTombstone();
    const kent = await db.person.create({ data: { name: "Timothy Kent", createdById: admin } });
    await optOutPerson(kent.id, new FormData());
    const other = (await db.photo.create({ data: { uploaderId: admin, originalName: "o.jpg", mimeType: "image/jpeg", storageKey: "o", originalPath: "o/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    await applyAnnotation(other, "m", record({ caption: "Timothy Kent blowing candles" }), { content: [] }, { requestedAt: new Date(), tombstone: ts });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: other } })).annotation as StoredAnnotation).caption).toBe("A family member blowing candles");
  });

  it("throw away an answer about a photograph in a trip whose title names them, asked for before the forget", async () => {
    const kent = await db.person.create({ data: { name: "Timothy Kent", createdById: admin } });
    const trip = await db.trip.create({ data: { slug: "bday", title: "Timothy Kent's 5th birthday", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } });
    const plain = (await db.photo.create({ data: { uploaderId: admin, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "p", originalPath: "p/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    const before = new Date(Date.now() - 60_000);
    await optOutPerson(kent.id, new FormData());
    await applyAnnotation(plain, "m", record({ caption: "Timothy on his birthday" }), { content: [] }, { requestedAt: before });
    expect(await db.photo.findUniqueOrThrow({ where: { id: plain } })).toMatchObject({ annotation: null, annotationError: "names_changed", namesScrubbedAt: null });
  });

  it("keep waiting forgets off the pool, give up after a while, and let go of the lock when a connection dies", async () => {
    let release!: () => void;
    const running = withForgetLock(() => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 100));
    // A dozen forgets waiting their turn, and the pool still answers at once.
    const waiting = Array.from({ length: 12 }, () => withForgetLock(async () => undefined, { ms: 5_000 }));
    const t = Date.now();
    await db.$queryRaw`SELECT 1`;
    expect(Date.now() - t).toBeLessThan(2_000);
    await expect(withForgetLock(async () => undefined, { ms: 200 })).rejects.toThrow(/Another person is being forgotten; try again in a few minutes/);
    // Answers being stored hold it shared and briefly: those are waited for, not refused.
    release();
    await running;
    await Promise.all(waiting);
    let stored!: () => void;
    const storing = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_try_advisory_xact_lock_shared(${0x666f7267}::bigint)`;
      await new Promise<void>((r) => (stored = r));
    });
    await new Promise((r) => setTimeout(r, 100));
    const queued = withForgetLock(async () => "after", { ms: 5_000 });
    await new Promise((r) => setTimeout(r, 200));
    // With a forget waiting in line, a new answer steps aside rather than starving it.
    const late = await db.$transaction(async (tx) => (await tx.$queryRaw<{ free: boolean }[]>`SELECT pg_try_advisory_xact_lock_shared(${0x666f7267}::bigint) AS free`)[0].free);
    expect(late).toBe(false);
    stored();
    await expect(queued).resolves.toBe("after");
    await storing;
    // A connection holding the lock that dies (a crashed worker) takes the lock with it.
    const crashed = new Client({ connectionString: process.env.DATABASE_URL });
    await crashed.connect();
    await crashed.query("SELECT pg_advisory_lock($1::bigint)", [0x666f7267]);
    await crashed.end();
    await expect(withForgetLock(async () => "done", { ms: 2_000 })).resolves.toBe("done");
  });

  it("are never forgotten two at a time", async () => {
    const spans: [number, number][] = [];
    const run = () => withForgetLock(async () => {
      const a = Date.now();
      await new Promise((r) => setTimeout(r, 150));
      spans.push([a, Date.now()]);
    });
    await Promise.all([run(), run()]);
    spans.sort((x, y) => x[0] - y[0]);
    expect(spans[1][0]).toBeGreaterThanOrEqual(spans[0][1]);
  });
});

describe("names that are also words", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
  });
  const photo = async () => (await db.photo.create({ data: { uploaderId: admin, originalName: "o.jpg", mimeType: "image/jpeg", storageKey: "o", originalPath: "o/o.jpg", sizeBytes: 1, status: "READY" } })).id;
  /** Forget somebody tagged on one photograph, and return it. */
  const forget = async (name: string) => {
    const p = await db.person.create({ data: { name, createdById: admin } });
    const on = await photo();
    await db.face.create({ data: { photoId: on, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await optOutPerson(p.id, new FormData());
    return on;
  };
  const sc = (id: string) => forgottenScope({ photoIds: [id] });
  /** Whether a forgotten row covers a photograph, as it keeps them: hashed under its key. */
  type Row = { keyVersion: number; photoIds: string[]; taggedPhotoIds: string[] };
  const covers = async (row: Row, id: string, field: "photoIds" | "taggedPhotoIds" = "photoIds") => row[field].includes((await hashedPhotoId(id, row.keyVersion))!);
  const taggedOn = async (id: string) => {
    for (const r of await db.forgottenName.findMany()) if (await covers(r, id, "taggedPhotoIds")) return r;
    return undefined;
  };

  it("keeps a one-word name to the photographs they were on, as a name is written", async () => {
    const on = await forget("Ximena");
    const ts = await loadTombstone();
    // On their own photograph strictly, in any case; off it, not at all.
    expect(ts.scrub("Ximena waved; ximena waved", await sc(on))).toBe("A family member waved; a family member waved");
    expect(ts.scrub("HAPPY BIRTHDAY XIMENA", await sc(on))).toBe("HAPPY BIRTHDAY A FAMILY MEMBER");
    // Anywhere else only full names count.
    expect(ts.scrub("Ximena waved", await sc(await photo()))).toBe("Ximena waved");
    expect(ts.scrub("Ximena waved")).toBe("Ximena waved");
    // No "a a family member": the article goes with the name.
    expect(ts.scrub("We met a Ximena at the fair", await sc(on))).toBe("We met a family member at the fair");
  });

  it("never keeps a one-word name that is an everyday word, a herb or a bird, and a month only for their photographs", async () => {
    for (const n of ["Grace", "Jack", "Will", "Sage", "Basil", "Robin", "Rosemary", "Wren", "Holly"]) await forget(n);
    expect(await db.forgottenName.count()).toBe(0);
    for (const n of ["June", "May"]) await forget(n);
    const ts = await loadTombstone();
    for (const t of ["Our trip in June", "Taken in May 2019", "Amazing Grace", "Grace Bay", "Union Jack", "Jack Russell", "Will you come?", "Sage green walls.", "Robin Hood"]) expect(ts.scrub(t)).toBe(t);
    const other = await photo();
    await applyAnnotation(other, "m", record({ caption: "Our trip in June", estimatedYear: { from: 2019, to: 2019, confidence: 0.8, evidence: "Taken in May 2019" } }), { content: [] }, { requestedAt: new Date() });
    const p = await db.photo.findUniqueOrThrow({ where: { id: other } });
    expect((p.annotation as StoredAnnotation).caption).toBe("Our trip in June");
    expect(p.estimatedDateNote).toBe("2019–2019: Taken in May 2019");
  }, 20_000);

  it("takes a month that is their first name out of their own photographs only where it plainly names somebody", async () => {
    const may = await forget("May Lee");
    const june = await forget("Aunt June");
    const ts = await loadTombstone();
    const cases: [string, string, string][] = [
      [may, "May at the lake", "A family member at the lake"],
      [may, "May and Ben built a fort.", "A family member and Ben built a fort."],
      [may, "May swam across. Then May waved.", "A family member swam across. Then a family member waved."],
      [may, "May At The Lake", "A Family Member At The Lake"],
      [june, "Aunt June smiled.", "A family member smiled."],
      [may, "May 2020 at the lake", "May 2020 at the lake"],
      [may, "A swim in May", "A swim in a family member"],
      [may, "A swim in May 2019", "A swim in May 2019"],
      [may, "May Day at the fair", "May Day at the fair"],
      [may, "May and June were hot", "A family member and June were hot"],
      // Nothing in a date's own shape says the month: on her own photograph it is her (strict-names.ts).
      [may, "May flowers by the lake", "A family member flowers by the lake"],
      [may, "Early May at the lake", "Early a family member at the lake"],
      [may, "At the lake, early May.", "At the lake, early a family member."],
      [may, "At the lake, early May, 2019.", "At the lake, early May, 2019."],
      [may, "Early May 2019 at the lake", "Early May 2019 at the lake"],
      [may, "Photos from the May holiday", "Photos from a family member holiday"],
      [may, "Our May trip at the lake", "Our a family member trip at the lake"],
      [may, "May lies ahead", "A family member lies ahead"],
      [may, "May looks at the cake.", "A family member looks at the cake."],
      [may, "May loves the swings.", "A family member loves the swings."],
      [may, "May, Ben and Sue at the lake", "A family member, Ben and Sue at the lake"],
      [may, "May, June and July were hot", "A family member, June and July were hot"],
      [may, "May waves at the camera", "A family member waves at the camera"],
      [june, "June waves crashed on the rocks", "A family member waves crashed on the rocks"],
      [june, "June hugs are the best", "A family member hugs are the best"],
      [may, "May is the best month", "A family member is the best month"],
    ];
    for (const [on, text, want] of cases) expect([text, ts.scrub(text, await sc(on))]).toEqual([text, want]);
    // In keywords and tags too, on her own photograph; not off their photographs.
    expect(ts.scrubSummary("may lake swim", await sc(may))).toBe("A family member lake swim");
    expect(ts.scrubSummary("lake swim may 2019", await sc(may))).toBe("lake swim may 2019");
    expect(ts.namesTag("may", await sc(may))).toBe(true);
    expect(ts.namesTag("may", await sc(await photo()))).toBe(false);
    expect(ts.scrub("May at the lake", await sc(await photo()))).toBe("May at the lake");
    expect(ts.scrub("May at the lake")).toBe("May at the lake");
    // A later answer on her photograph.
    await applyAnnotation(may, "m", record({ caption: "May at the lake in May 2020" }), { content: [] }, { requestedAt: new Date() });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: may } })).annotation as StoredAnnotation).caption).toBe("A family member at the lake in May 2020");
  });

  it("leaves a place plainly meant alone, even on their photographs", async () => {
    const on = await forget("Florence");
    const ts = await loadTombstone();
    // On her own photograph every Florence is her, the city too (strict-names.ts); off it, the city stays.
    for (const t of ["Florence, Italy in spring.", "A trip to Florence, Italy", "Florence Nightingale statue", "Florence 2019", "Florence trip"]) {
      expect(ts.scrub(t, await sc(on))).toBe(t.replace(/^Florence/u, "A family member").replace(/Florence/u, "a family member"));
      expect(ts.scrub(t, await sc(await photo()))).toBe(t);
    }
    // On her photographs she is the likelier reading after "in" or "to".
    expect(ts.scrub("By the pool with Florence", await sc(on))).toBe("By the pool with a family member");
    // Where somebody is somewhere, it is the place: "in Florence." at the end of a sentence.
    expect(ts.scrub("Florence and Ben stayed in Florence.", await sc(on))).toBe("A family member and Ben stayed in a family member.");
    expect(ts.scrub("We stayed in Florence, then Florence slept.", await sc(on))).toBe("We stayed in a family member, then a family member slept.");
    for (const [t, want] of [["We flew to Florence.", "We flew to a family member."], ["We visited Florence, Italy", "We visited a family member, Italy"], ["Ben leaned in Florence.", "Ben leaned in a family member."], ["Ben ran back to Florence for a hug.", "Ben ran back to a family member for a hug."], ["Ben visited Florence in hospital.", "Ben visited a family member in hospital."]]) expect(ts.scrub(t, await sc(on))).toBe(want);
    // Elsewhere, not at all.
    const elsewhere = await photo();
    expect(ts.scrub("Florence in spring", await sc(elsewhere))).toBe("Florence in spring");
    expect(ts.namesTag("florence", await sc(elsewhere))).toBe(false);
    // Hers where it is her: after a capitalized word that ended the sentence before, and "Left to right: Florence, Ben".
    expect(ts.scrub("We drove to Maine. Florence swam.", await sc(on))).toBe("We drove to Maine. A family member swam.");
  });

  it("is a person after 'to', 'at', 'from' or 'near' unless it is a place", async () => {
    const on = await forget("Ximena");
    await db.person.create({ data: { name: "Ben Ortiz", createdById: admin } });
    const ts = await loadTombstone();
    expect(ts.scrub("Grandpa smiling at Ximena, waving to Ximena, a gift from Ximena, sitting near Ximena", await sc(on))).toBe("Grandpa smiling at a family member, waving to a family member, a gift from a family member, sitting near a family member");
    expect(ts.scrub("Left to right: Ximena, Ben.", await sc(on))).toBe("Left to right: a family member, Ben.");
  });

  it("counts a one-word name in tags only as the whole tag or its possessive, and in a search summary only on its own", async () => {
    const on = await forget("Ximena");
    const ts = await loadTombstone();
    expect(ts.namesTag("ximena", await sc(on))).toBe(true);
    expect(ts.namesTag("ximena's", await sc(on))).toBe(true);
    // On their own photograph any tag or keyword holding it (strict-names.ts).
    expect(ts.namesTag("ximena pool", await sc(on))).toBe(true);
    expect(ts.namesTag("ximena pool", await sc(await photo()))).toBe(false);
    expect(ts.scrubSummary("fishing, ximena may 2019; ximena florence", await sc(on))).toBe("fishing, a family member may 2019; a family member florence");
    expect(ts.scrubSummary("ximena fishing", await sc(await photo()))).toBe("ximena fishing");
    await applyAnnotation(on, "m", record({ tags: ["ximena", "Ximena's", "pool"], searchSummary: "ximena fishing trout" }), { content: [] }, { requestedAt: new Date() });
    expect((await db.photo.findUniqueOrThrow({ where: { id: on } })).annotation).toMatchObject({ tags: ["pool"], searchSummary: "A family member fishing trout" });
  });

  it("is looked for on every photograph the forget went through: tagged, named in notes, or in a trip that names them", async () => {
    const p = await db.person.create({ data: { name: "Ximena", createdById: admin } });
    const tagged = await photo();
    await db.face.create({ data: { photoId: tagged, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const noted = (await db.photo.create({ data: { uploaderId: admin, originalName: "n.jpg", mimeType: "image/jpeg", storageKey: "n", originalPath: "n/o.jpg", sizeBytes: 1, status: "READY", context: "Ximena caught a trout" } })).id;
    const trip = await db.trip.create({ data: { slug: "x", title: "Ximena's birthday", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } });
    const inTrip = (await db.photo.create({ data: { uploaderId: admin, originalName: "t.jpg", mimeType: "image/jpeg", storageKey: "t", originalPath: "t/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    const later = (await db.photo.create({ data: { uploaderId: admin, originalName: "l.jpg", mimeType: "image/jpeg", storageKey: "l", originalPath: "l/o.jpg", sizeBytes: 1, status: "READY" } })).id;
    await optOutPerson(p.id, new FormData());
    // Added to the trip after the forget: the trip named her, so its photographs count too.
    await db.photo.update({ where: { id: later }, data: { tripId: trip.id } });
    for (const id of [tagged, noted, inTrip, later]) {
      await applyAnnotation(id, "m", record({ caption: "Ximena with a trout" }), { content: [] }, { requestedAt: new Date() });
      expect(((await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation).caption).toBe("A family member with a trout");
    }
    // The trip described as a whole counts by all its photographs.
    expect((await loadTombstone()).scrub("Ximena turned five", await forgottenScope({ containers: [{ kind: "trip", id: trip.id }] }))).toBe("A family member turned five");
    expect((await loadTombstone()).scrub("Ximena turned five", await sc(await photo()))).toBe("Ximena turned five");
  });

  it("keeps the photographs and trips a one-word name covers hashed, and hashes a row kept before they were", async () => {
    const p = await db.person.create({ data: { name: "Ximena", createdById: admin } });
    const tagged = await photo();
    await db.face.create({ data: { photoId: tagged, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const trip = await db.trip.create({ data: { slug: "x", title: "Ximena's birthday", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } });
    await optOutPerson(p.id, new FormData());
    const [row] = await db.forgottenName.findMany();
    const kept = [...row.photoIds, ...row.taggedPhotoIds, ...row.containerIds];
    expect(kept.length).toBeGreaterThan(0);
    for (const x of kept) expect(x).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(tagged);
    expect(JSON.stringify(row)).not.toContain(trip.id);
    expect(await covers(row, tagged, "taggedPhotoIds")).toBe(true);
    // A row from before: plain ids, still matched, then hashed in place.
    await db.forgottenName.update({ where: { hash: row.hash }, data: { photoIds: [tagged], taggedPhotoIds: [tagged], containerIds: [`trip:${trip.id}`] } });
    const inTrip = (await db.photo.create({ data: { uploaderId: admin, originalName: "t.jpg", mimeType: "image/jpeg", storageKey: "t", originalPath: "t/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    const check = async () => {
      const ts = await loadTombstone();
      expect(ts.scrub("Ximena waved", await sc(tagged))).toBe("A family member waved");
      expect(ts.scrub("Ximena waved", await sc(inTrip))).toBe("A family member waved");
      expect(ts.scrub("Ximena waved", await forgottenScope({ containers: [{ kind: "trip", id: trip.id }] }))).toBe("A family member waved");
      expect(ts.scrub("Ximena waved", await sc(await photo()))).toBe("Ximena waved");
    };
    await check();
    // Only the photograph itself kept, plain: a whole trip holding it still counts it.
    await db.forgottenName.update({ where: { hash: row.hash }, data: { photoIds: [inTrip], taggedPhotoIds: [], containerIds: [] } });
    expect((await loadTombstone()).scrub("Ximena at the lake", await forgottenScope({ containers: [{ kind: "trip", id: trip.id }] }))).toBe("A family member at the lake");
    await db.forgottenName.update({ where: { hash: row.hash }, data: { photoIds: [tagged], taggedPhotoIds: [tagged], containerIds: [`trip:${trip.id}`] } });
    expect(await hashPlainScopes()).toBe(1);
    const after = await db.forgottenName.findUniqueOrThrow({ where: { hash: row.hash } });
    expect(JSON.stringify(after)).not.toContain(tagged);
    expect(JSON.stringify(after)).not.toContain(trip.id);
    await check();
    expect(await hashPlainScopes()).toBe(0);
  });

  it("keeps the photographs of everybody forgotten under the same one-word name", async () => {
    const first = await forget("Ximena");
    const second = await forget("Ximena");
    expect(await db.forgottenName.count()).toBe(1);
    const ts = await loadTombstone();
    for (const on of [first, second]) expect(ts.scrub("Ximena waved", await sc(on))).toBe("A family member waved");
  });

  it("keeps a one-word name out of her photographs though somebody the album knows shares it, and leaves theirs", async () => {
    const ruiz = await db.person.create({ data: { name: "Ximena Ruiz", createdById: admin } });
    const p = await db.person.create({ data: { name: "Ximena", createdById: admin } });
    const hers = await photo();
    await db.face.create({ data: { photoId: hers, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    // A trip whose title named her holds a photograph of Ximena Ruiz.
    const trip = await db.trip.create({ data: { slug: "party", title: "Ximena's party", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } });
    const theirs = (await db.photo.create({ data: { uploaderId: admin, originalName: "r.jpg", mimeType: "image/jpeg", storageKey: "r", originalPath: "r/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    await db.face.create({ data: { photoId: theirs, personId: ruiz.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await optOutPerson(p.id, new FormData());
    const ts = await loadTombstone();
    expect(ts.scrub("Ximena waved", await sc(hers))).toBe("A family member waved");
    expect(ts.scrub("Ximena waved", await sc(theirs))).toBe("Ximena waved");
  });

  it("leaves the family's Florence trip alone when a Florence is forgotten", async () => {
    const p = await db.person.create({ data: { name: "Florence", createdById: admin } });
    const tripA = await db.trip.create({ data: { slug: "a", title: "Florence and Tuscany 2019", startDate: new Date("2019-05-01"), endDate: new Date("2019-05-09"), createdById: admin } });
    const tripB = await db.trip.create({ data: { slug: "b", title: "Florence, Italy", startDate: new Date("2021-05-01"), endDate: new Date("2021-05-09"), createdById: admin } });
    const inTrip = async (tripId: string, caption: string) => (await db.photo.create({ data: { uploaderId: admin, originalName: "d.jpg", mimeType: "image/jpeg", storageKey: "d", originalPath: "d/o.jpg", sizeBytes: 1, status: "READY", tripId, annotation: record({ caption }), annotatedAt: new Date() } })).id;
    const hers = await inTrip(tripA.id, "Florence waved by the fountain");
    await db.face.create({ data: { photoId: hers, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const duomo = await inTrip(tripA.id, "The Duomo in Florence");
    const skyline = await inTrip(tripB.id, "Florence skyline at dusk");
    await optOutPerson(p.id, new FormData());
    const caption = async (id: string) => ((await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation).caption;
    expect(await caption(hers)).toBe("A family member waved by the fountain");
    expect(await caption(duomo)).toBe("The Duomo in Florence");
    expect(await caption(skyline)).toBe("Florence skyline at dusk");
    // New answers: her photograph loses the name; the trip's others, trip B and a later upload keep it.
    const later = await inTrip(tripA.id, "");
    for (const [id, text, want] of [[hers, "Florence smiling", "A family member smiling"], [duomo, "Florence at sunset", "Florence at sunset"], [skyline, "Florence in spring", "Florence in spring"], [later, "Florence and the Arno", "Florence and the Arno"]] as const) {
      await applyAnnotation(id, "m", record({ caption: text }), { content: [] }, { requestedAt: new Date() });
      expect(await caption(id)).toBe(want);
    }
    const ts = await loadTombstone();
    expect(ts.scrub("Florence and Tuscany 2019", await forgottenScope({ containers: [{ kind: "trip", id: tripA.id }] }))).toBe("Florence and Tuscany 2019");
    expect(ts.scrub("Trip: Florence", await sc(hers))).toBe("Trip: a family member");
  });

  it("keeps a place-named person's name out of her own photographs unless a place is plainly meant", async () => {
    const on = await forget("Florence");
    const ts = await loadTombstone();
    const scope = await sc(on);
    for (const [t, want] of [["Florence at the lake", "A family member at the lake"], ["Florence and Ben swam.", "A family member and Ben swam."], ["Florence in the garden", "A family member in the garden"], ["Florence, Italy", "A family member, Italy"], ["Trip: Florence", "Trip: a family member"], ["Florence 2019", "A family member 2019"]]) expect(ts.scrub(t, scope)).toBe(want);
    // Off her photographs, nothing.
    expect(ts.scrub("Florence at the lake", await sc(await photo()))).toBe("Florence at the lake");
  });

  it("scrubs a place-named person out of what the helper wrote on her photographs, keywords included", async () => {
    const photos: Record<string, string> = {};
    for (const name of ["Charlotte Smith", "Madison"]) {
      const first = name.split(" ")[0];
      const p = await db.person.create({ data: { name, createdById: admin } });
      const on = (await db.photo.create({ data: { uploaderId: admin, originalName: "c.jpg", mimeType: "image/jpeg", storageKey: "c", originalPath: "c/o.jpg", sizeBytes: 1, status: "READY", annotation: record({ title: first, caption: `${first} in the garden`, description: `${first} and Ben swam. ${first} at the pool. ${first} smiles.`, searchSummary: `${first.toLowerCase()} garden` }), annotatedAt: new Date() } })).id;
      await db.face.create({ data: { photoId: on, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
      photos[first] = on;
      await optOutPerson(p.id, new FormData());
      expect((await db.photo.findUniqueOrThrow({ where: { id: on } })).annotation).toMatchObject({ title: "A family member", caption: "A family member in the garden", description: "A family member and Ben swam. A family member at the pool. A family member smiles.", searchSummary: "A family member garden" });
    }
    // And in later answers, for the one-word name the album remembers.
    const madison = photos.Madison;
    await applyAnnotation(madison, "m", record({ caption: "Madison in the garden", searchSummary: "madison garden" }), { content: [] }, { requestedAt: new Date() });
    expect((await db.photo.findUniqueOrThrow({ where: { id: madison } })).annotation).toMatchObject({ caption: "A family member in the garden", searchSummary: "A family member garden" });
  });

  it("keeps photographs whose notes name her in scope, whatever the words around it", async () => {
    const p = await db.person.create({ data: { name: "Florence", createdById: admin } });
    const noted = (await db.photo.create({ data: { uploaderId: admin, originalName: "n.jpg", mimeType: "image/jpeg", storageKey: "n", originalPath: "n/o.jpg", sizeBytes: 1, status: "READY", context: "Florence at the pool" } })).id;
    await optOutPerson(p.id, new FormData());
    expect(await covers(await db.forgottenName.findFirstOrThrow(), noted)).toBe(true);
    await applyAnnotation(noted, "m", record({ caption: "Florence dives in" }), { content: [] }, { requestedAt: new Date() });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: noted } })).annotation as StoredAnnotation).caption).toBe("A family member dives in");
  });

  it("leaves a city trip's notes, prompts and answers alone when a Florence is forgotten", async () => {
    const p = await db.person.create({ data: { name: "Florence", createdById: admin } });
    const hers = await photo();
    await db.face.create({ data: { photoId: hers, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const trip = await db.trip.create({ data: { slug: "italy", title: "Italy 2019", startDate: new Date("2019-05-01"), endDate: new Date("2019-05-09"), createdById: admin } });
    const noting = async (context: string) => (await db.photo.create({ data: { uploaderId: admin, originalName: "i.jpg", mimeType: "image/jpeg", storageKey: "i", originalPath: "i/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id, context } })).id;
    const city = [await noting("Duomo in Florence"), await noting("Florence skyline at sunset"), await noting("Our trip to Florence, Italy")];
    const pool = await noting("Florence at the pool");
    await optOutPerson(p.id, new FormData());
    const row = await db.forgottenName.findFirstOrThrow();
    for (const id of city) expect(await covers(row, id)).toBe(false);
    for (const id of [hers, pool]) expect(await covers(row, id)).toBe(true);
    for (const id of city) {
      const item = (await loadItem(id))!;
      expect((await withoutUnpermittedNames(item)).context).toBe(item.context);
      await applyAnnotation(id, "m", record({ caption: "Florence at dusk from the Duomo" }), { content: [] }, { requestedAt: new Date() });
      expect(((await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation).caption).toBe("Florence at dusk from the Duomo");
    }
    await applyAnnotation(pool, "m", record({ caption: "Florence at the pool" }), { content: [] }, { requestedAt: new Date() });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: pool } })).annotation as StoredAnnotation).caption).toBe("A family member at the pool");
  });

  it("keeps a forgotten full name's first name on their own photographs and where notes name them in full", async () => {
    const sam = await db.person.create({ data: { name: "Sam Kent", createdById: admin } });
    const trip = await db.trip.create({ data: { slug: "sam5", title: "Sam's 5th birthday", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } });
    const inTrip = async (data: { caption?: string; context?: string } = {}) => (await db.photo.create({ data: { uploaderId: admin, originalName: "k.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id, ...data } })).id;
    const tagged = await inTrip();
    const mate = await inTrip({ caption: "Sam blew out the candles" });
    const inFull = await photo();
    await db.photo.update({ where: { id: inFull }, data: { context: "Sam Kent at the zoo" } });
    const zoo = await photo();
    await db.photo.update({ where: { id: zoo }, data: { context: "Sam at the zoo" } });
    await db.face.create({ data: { photoId: tagged, personId: sam.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    // Not to be named yet: the trip-mate's words go without him.
    expect(await withoutUnpermittedNames((await loadItem(mate))!)).toMatchObject({ caption: "A family member blew out the candles", trip: { title: "A family member's 5th birthday" } });
    await optOutPerson(sam.id, new FormData());
    const caption = async (id: string, text: string) => {
      await applyAnnotation(id, "m", record({ caption: text }), { content: [] }, { requestedAt: new Date() });
      return ((await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation).caption;
    };
    expect(await caption(tagged, "Sam at the lake")).toBe("A family member at the lake");
    expect(await caption(inFull, "Sam smiling")).toBe("A family member smiling");
    // Accepted: a trip-mate's photograph that never names him in full, or somebody else's "Sam", keeps it.
    expect(await caption(mate, "Sam blowing out candles")).toBe("Sam blowing out candles");
    expect(await caption(zoo, "Sam at the zoo")).toBe("Sam at the zoo");
    // "Uncle Sam" is somebody else.
    // On his own photograph "Uncle Sam" is him.
    expect(await caption(tagged, "Uncle Sam hugged the kids.")).toBe("A family member hugged the kids.");
  });

  it("leaves a first name to somebody the album knows who has it only where they are tagged", async () => {
    const ortiz = await db.person.create({ data: { name: "Sam Ortiz", createdById: admin } });
    const kent = await db.person.create({ data: { name: "Sam Kent", createdById: admin } });
    const tag = async (photoId: string, personId: string) => db.face.create({ data: { photoId, personId, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const his = await photo();
    const both = await photo();
    const elsewhere = await photo();
    await tag(his, kent.id);
    await tag(both, kent.id);
    await tag(both, ortiz.id);
    await tag(elsewhere, ortiz.id);
    await optOutPerson(kent.id, new FormData());
    const ts = await loadTombstone();
    expect(ts.scrub("Sam at the lake", await sc(his))).toBe("A family member at the lake");
    expect(ts.scrub("Sam at the lake", await sc(both))).toBe("Sam at the lake");
    expect(ts.scrub("Sam at the lake", await sc(elsewhere))).toBe("Sam at the lake");
  });

  it("keeps every first-name form of a forgotten full name out of their own photographs", async () => {
    for (const [name, first] of [["Jack Byron", "Jack"], ["Grace Hill", "Grace"], ["Will Turner", "Will"], ["Grandma Ruth", "Ruth"], ["Mary Ann Smith", "Mary Ann"]]) {
      const on = await forget(name);
      await applyAnnotation(on, "m", record({ caption: `${first} at the lake` }), { content: [] }, { requestedAt: new Date() });
      expect(((await db.photo.findUniqueOrThrow({ where: { id: on } })).annotation as StoredAnnotation).caption).toBe("A family member at the lake");
    }
    const may = await forget("May Lee");
    await applyAnnotation(may, "m", record({ caption: "May 2020 at the lake" }), { content: [] }, { requestedAt: new Date() });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: may } })).annotation as StoredAnnotation).caption).toBe("May 2020 at the lake");
  }, 20_000);

  it("on her own photograph, a place-like first name is her after 'to' or 'from' unless she travels there", async () => {
    const on = await forget("Charlotte Smith");
    const ts = await loadTombstone();
    const scope = await sc(on);
    for (const [t, want] of [["Ben waved to Charlotte.", "Ben waved to a family member."], ["A gift from Charlotte.", "A gift from a family member."], ["We flew to Charlotte.", "We flew to a family member."], ["Charlotte, NC", "A family member, NC"]]) expect(ts.scrub(t, scope)).toBe(want);
  });

  it("leaves notes about the place out of a place-named person's forget", async () => {
    const charlotte = await db.person.create({ data: { name: "Charlotte", createdById: admin } });
    const hers = await photo();
    await db.face.create({ data: { photoId: hers, personId: charlotte.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const nc = await db.trip.create({ data: { slug: "nc", title: "Charlotte, NC 2020", startDate: new Date("2020-07-01"), endDate: new Date("2020-07-01"), createdById: admin } });
    const rain = (await db.photo.create({ data: { uploaderId: admin, originalName: "r.jpg", mimeType: "image/jpeg", storageKey: "r", originalPath: "r/o.jpg", sizeBytes: 1, status: "READY", tripId: nc.id, context: "Charlotte in the rain" } })).id;
    await optOutPerson(charlotte.id, new FormData());
    expect(await covers(await db.forgottenName.findFirstOrThrow(), rain)).toBe(false);

    const florence = await db.person.create({ data: { name: "Florence", createdById: admin } });
    const own = await photo();
    await db.face.create({ data: { photoId: own, personId: florence.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const located = (await db.photo.create({ data: { uploaderId: admin, originalName: "l.jpg", mimeType: "image/jpeg", storageKey: "l", originalPath: "l/o.jpg", sizeBytes: 1, status: "READY", placeName: "Florence, Tuscany, Italy", context: "Florence was lovely in the rain" } })).id;
    const trip = await db.trip.create({ data: { slug: "f19", title: "Florence 2019", startDate: new Date("2019-05-01"), endDate: new Date("2019-05-09"), createdById: admin } });
    const notes = ["Florence at night", "Florence in the rain", "Florence from Piazzale Michelangelo", "Florence and Siena by train", "Florence by bike", "Florence, day 3", "Arrived in Florence. Florence is hot."];
    const inTrip: string[] = [];
    for (const context of notes) inTrip.push((await db.photo.create({ data: { uploaderId: admin, originalName: "f.jpg", mimeType: "image/jpeg", storageKey: "f", originalPath: "f/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id, context } })).id);
    const pool = (await db.photo.create({ data: { uploaderId: admin, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "p", originalPath: "p/o.jpg", sizeBytes: 1, status: "READY", context: "Florence at the pool" } })).id;
    await optOutPerson(florence.id, new FormData());
    const row = (await taggedOn(own))!;
    for (const id of [located, ...inTrip]) expect(await covers(row, id)).toBe(false);
    expect(await covers(row, pool)).toBe(true);
    for (const id of [located, ...inTrip]) {
      const item = (await loadItem(id))!;
      expect((await withoutUnpermittedNames(item)).context).toBe(item.context);
      await applyAnnotation(id, "m", record({ caption: "Florence at night", tags: ["florence", "night"] }), { content: [] }, { requestedAt: new Date() });
      expect((await db.photo.findUniqueOrThrow({ where: { id } })).annotation).toMatchObject({ caption: "Florence at night", tags: ["florence", "night"] });
    }
    await applyAnnotation(pool, "m", record({ caption: "Florence at the pool" }), { content: [] }, { requestedAt: new Date() });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: pool } })).annotation as StoredAnnotation).caption).toBe("A family member at the pool");
  }, 20_000);

  it("takes a kinship word with their first name on their own photograph, unless it is somebody else's", async () => {
    const kent = await forget("Sam Kent");
    const kelly = await forget("Grace Kelly");
    const ruth = await forget("Grandma Ruth");
    const will = await forget("Will Turner");
    const jack = await forget("Jack Brown");
    const ts = await loadTombstone();
    const cases: [string, string, string][] = [
      [kent, "Grandpa Sam at the lake", "A family member at the lake"],
      [kent, "Ben and Grandpa Sam blew out candles", "Ben and a family member blew out candles"],
      [kelly, "Aunt Grace smiled", "A family member smiled"],
      [kent, "Uncle Sam hat on Ben", "A family member hat on Ben"],
      [ruth, "Aunt Ruth waves", "A family member waves"],
      [ruth, "Ruth waves", "A family member waves"],
      [will, "Will you look at that!", "A family member you look at that!"],
      [jack, "Jack in the box", "A family member in the box"],
    ];
    for (const [on, text, want] of cases) expect(ts.scrub(text, await sc(on))).toBe(want);
    // A hyphenated kinship word goes whole, as in the forget-time scrub.
    const ada = await forget("Ada Byron");
    const ts2 = await loadTombstone();
    expect(ts2.scrub("Great-Aunt Ada at the lake", await sc(ada))).toBe("A family member at the lake");
    expect(nameMatcher(["Ada Byron"]).scrub("Great-Aunt Ada at the lake", { tagged: true })).toBe("A family member at the lake");
    const greatAunt = await forget("Great-Aunt Rosa");
    const ts3 = await loadTombstone();
    // On her own photograph every Rosa is her, whatever title stands before it (strict-names.ts).
    expect(ts3.scrub("Aunt Rosa waves", await sc(greatAunt))).toBe("A family member waves");
    expect(ts3.scrub("Step-Mom Rosa waves", await sc(greatAunt))).toBe("A family member waves");
    expect(ts3.scrub("Great-Aunt Rosa waves", await sc(greatAunt))).toBe("A family member waves");
    // A title of several words is one title, hyphenated or not, in both scrubs.
    for (const [text, want] of [["Great-Grandma Ruth smiled.", "A family member smiled."], ["Great Grandma Ruth smiled.", "A family member smiled."], ["Grandma Ruth smiled.", "A family member smiled."]]) {
      expect(ts.scrub(text, await sc(ruth))).toBe(want);
      expect(nameMatcher(["Grandma Ruth"]).scrub(text, { tagged: true })).toBe(want);
    }
    for (const text of ["Great Aunt Ada swam.", "Great-Aunt Ada swam."]) {
      expect(ts2.scrub(text, await sc(ada))).toBe("A family member swam.");
      expect(nameMatcher(["Ada Byron"]).scrub(text, { tagged: true })).toBe("A family member swam.");
    }
    expect(ts3.scrub("Great Aunt Rosa waves", await sc(greatAunt))).toBe("A family member waves");
    expect(ts.scrub("Nana Ruth bakes", await sc(ruth))).toBe("A family member bakes");
    // Elsewhere, "Grandpa Sam" is somebody else's, and "Uncle Sam" the saying.
    expect(ts.scrub("Uncle Sam hat on Ben", await sc(await photo()))).toBe("Uncle Sam hat on Ben");
    expect(ts.scrub("Grandpa Sam at the lake", await sc(await photo()))).toBe("Grandpa Sam at the lake");
  }, 20_000);

  it("cleans a photograph two forgotten namesakes shared again once the second is gone, with both their titles", async () => {
    const byron = await db.person.create({ data: { name: "Grandma Ada Byron", createdById: admin } });
    const lovelace = await db.person.create({ data: { name: "Aunt Ada Lovelace", createdById: admin } });
    const caption = "Grandma Ada and Aunt Ada at the lake. Ada waves.";
    const both = (await db.photo.create({ data: { uploaderId: admin, originalName: "b.jpg", mimeType: "image/jpeg", storageKey: "b", originalPath: "b/o.jpg", sizeBytes: 1, status: "READY", title: "Grandma Ada At The Lake", titleByHelper: true, annotation: record({ title: "Grandma Ada At The Lake", caption }), annotatedAt: new Date() } })).id;
    for (const p of [byron, lovelace]) await db.face.create({ data: { photoId: both, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const read = async () => {
      const p = await db.photo.findUniqueOrThrow({ where: { id: both } });
      return [p.title, (p.annotation as StoredAnnotation).title, (p.annotation as StoredAnnotation).caption];
    };
    // The first forget leaves "Ada" to Ada Lovelace, still in the album and on the photograph.
    await optOutPerson(byron.id, new FormData());
    expect(await read()).toEqual(["Grandma Ada At The Lake", "Grandma Ada At The Lake", caption]);
    // The second takes out her own title and name, and then, with both entries, Grandma Ada's too.
    await optOutPerson(lovelace.id, new FormData());
    expect(await read()).toEqual(["A Family Member At The Lake", "A Family Member At The Lake", "A family member and a family member at the lake. A family member waves."]);
    // A later answer there too: a title is accepted when it is either one's, since it names one of them, not both.
    await applyAnnotation(both, "m", record({ caption: "Aunt Ada hugs Grandma Ada." }), { content: [] }, { requestedAt: new Date() });
    expect((await read())[2]).toBe("A family member hugs a family member.");
  });

  it("keeps each forgotten person's kinship title to their own photographs when two share a first name", async () => {
    const greatAunt = await forget("Great Aunt Ada");
    const byron = await forget("Ada Byron");
    const ts = await loadTombstone();
    for (const text of ["Grandma Ada laughed.", "Step Mom Ada waved.", "Aunt Ada smiled."]) expect(ts.scrub(text, await sc(byron))).toBe(`A family member ${text.split(" ").slice(-1)[0]}`);
    expect(ts.scrub("Aunt Ada smiled.", await sc(greatAunt))).toBe("A family member smiled.");
    expect(ts.scrub("Great Aunt Ada at the lake", await sc(greatAunt))).toBe("A family member at the lake");
    expect(ts.scrub("Grand-Aunt Ada at the lake", await sc(greatAunt))).toBe("A family member at the lake");
    // Which photographs each forgotten Ada was on is not readable without the key.
    const groups = JSON.stringify((await db.forgottenName.findMany()).map((r) => r.kinshipGroups));
    for (const id of [greatAunt, byron]) expect(groups).not.toContain(id);
  });

  it("takes a half- or step- title, or a descriptor before a kinship word, whole with the name", async () => {
    const on = await forget("Ada Lee");
    const ts = await loadTombstone();
    for (const [text, want] of [["Half-Sister Ada swam.", "A family member swam."], ["Half Sister Ada swam.", "A family member swam."], ["Half Brother Ada sang.", "A family member sang."], ["Step Mom Ada waved.", "A family member waved."], ["Big Sister Ada swam.", "A family member swam."], ["Little Brother Ada swam.", "A family member swam."]]) {
      expect(ts.scrub(text, await sc(on))).toBe(want);
      expect(nameMatcher(["Ada Lee"]).scrub(text, { tagged: true })).toBe(want);
    }
  });

  it("capitalizes the stand-in the same way in both scrubs, judged without the titles that go with the name", async () => {
    const on = await forget("Ada Byron");
    const ts = await loadTombstone();
    for (const [text, want] of [
      ["Little Sister Ada and Big Brother Ada.", "A family member and a family member."],
      ["Grandma Ada At The Lake", "A Family Member At The Lake"],
      ["Big Sister Ada Swimming At The Lake", "A Family Member Swimming At The Lake"],
      ["We met Aunt Ada at the lake.", "We met a family member at the lake."],
    ]) {
      expect([text, ts.scrub(text, await sc(on))]).toEqual([text, want]);
      expect([text, nameMatcher(["Ada Byron"]).scrub(text, { tagged: true })]).toEqual([text, want]);
    }
  });

  it("reads 'Great' as a title only before a kinship word", async () => {
    const on = await forget("Ada Byron");
    const ts = await loadTombstone();
    for (const [text, want] of [["The Great Ada show.", "The Great a family member show."], ["Alexander the Great Ada.", "Alexander the Great a family member."]]) {
      expect(ts.scrub(text, await sc(on))).toBe(want);
      expect(nameMatcher(["Ada Byron"]).scrub(text, { tagged: true })).toBe(want);
    }
  });

  it("visits a place only with a real place after it, on her own photograph", async () => {
    const on = await forget("Charlotte Brown");
    const ts = await loadTombstone();
    const m = nameMatcher(["Charlotte Brown"]);
    for (const [text, want] of [["Visiting Charlotte and Ben.", "Visiting a family member and Ben."], ["Visiting Charlotte and Raleigh.", "Visiting a family member and Raleigh."], ["Visiting Charlotte, NC.", "Visiting A Family Member, NC."], ["Visiting Charlotte 2020", "Visiting a family member 2020"]]) {
      expect(ts.scrub(text, await sc(on))).toBe(want);
      expect(m.scrub(text, { tagged: true })).toBe(want);
    }
  });

  it("travels to a place-named person's city on her own photograph", async () => {
    const on = await forget("Charlotte");
    const ts = await loadTombstone();
    expect(ts.scrub("We flew to Charlotte.", await sc(on))).toBe("We flew to a family member.");
    expect(ts.scrub("We flew to Charlotte.", await sc(await photo()))).toBe("We flew to Charlotte.");
    expect(ts.scrub("Ben waved to Charlotte.", await sc(on))).toBe("Ben waved to a family member.");
  });

  it("leaves a forgotten first name alone where notes name a living namesake in full", async () => {
    await db.person.create({ data: { name: "Sam Ortiz", createdById: admin } });
    const kent = await db.person.create({ data: { name: "Sam Kent", createdById: admin } });
    const his = await photo();
    await db.face.create({ data: { photoId: his, personId: kent.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const both = await photo();
    await db.photo.update({ where: { id: both }, data: { context: "Sam Kent and Sam Ortiz at the lake" } });
    const alone = await photo();
    await db.photo.update({ where: { id: alone }, data: { context: "Sam Kent at the lake" } });
    await optOutPerson(kent.id, new FormData());
    const ts = await loadTombstone();
    expect(ts.scrub("Sam waved", await sc(both))).toBe("Sam waved");
    expect(ts.scrub("Sam waved", await sc(alone))).toBe("A family member waved");
  });

  it("leaves notes about the place in a trip with no place in its name", async () => {
    const florence = await db.person.create({ data: { name: "Florence", createdById: admin } });
    await db.person.create({ data: { name: "Ben Ortiz", createdById: admin } });
    const own = await photo();
    await db.face.create({ data: { photoId: own, personId: florence.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const trip = await db.trip.create({ data: { slug: "tus", title: "Tuscany", description: "Two weeks driving around.", startDate: new Date("2019-05-01"), endDate: new Date("2019-05-14"), createdById: admin } });
    const note = async (context: string, tripId: string | null = trip.id) => (await db.photo.create({ data: { uploaderId: admin, originalName: "t.jpg", mimeType: "image/jpeg", storageKey: "t", originalPath: "t/o.jpg", sizeBytes: 1, status: "READY", tripId, context } })).id;
    const place = [await note("Florence at night"), await note("Florence and Siena by train"), await note("Florence in the rain"), await note("Ponte Vecchio. Florence at dusk"), await note("Florence at night", null), await note("Florence vs Rome", null), await note("Florence at night with the Duomo lit up", null), await note("Florence at dusk with Siena beyond", null), await note("Florence at sunset with her camera", null), await note("Florence at sunset with Brunelleschi's dome", null), await note("Florence at dusk with Santa Croce", null), await note("Florence at night with Ponte Vecchio behind", null)];
    const pool = await note("Florence at the pool", null);
    // Somebody else in the scene: she is in it too.
    const people = [await note("Florence at sunset with Grandpa", null), await note("Florence at night with Ben", null), await note("Florence in the rain with her dad", null), await note("Florence at sunset, with friends", null), await note("Florence at dusk with the cousins", null)];
    await optOutPerson(florence.id, new FormData());
    const row = (await taggedOn(own))!;
    for (const id of place) expect(await covers(row, id)).toBe(false);
    for (const id of [pool, ...people]) expect(await covers(row, id)).toBe(true);
  });

  it("keeps kinship words hashed, since some are names", async () => {
    for (const name of ["Tia Johnson", "Nan Smith", "Oma Lee", "Nana Ama Mensah", "Grand Duke Ivan"]) await forget(name);
    const words = new Set(["tia", "nan", "oma", "nana", "grand", "duke", "grandma", "aunt", "grand duke", "nana ama"]);
    const rows = await db.forgottenName.findMany();
    const kin = (r: (typeof rows)[number]) => (r.kinshipGroups as { kin: string[] }[]).flatMap((g) => g.kin);
    expect(rows.some((r) => kin(r).length > 0)).toBe(true);
    for (const r of rows) for (const k of kin(r)) expect(words.has(k)).toBe(false);
    expect(JSON.stringify(rows.map(kin))).not.toMatch(/tia|nan|oma|grand|duke/i);
  }, 20_000);

  it("reads 'in the sun' as the place only where the phrase ends", async () => {
    const florence = await db.person.create({ data: { name: "Florence", createdById: admin } });
    const own = await photo();
    await db.face.create({ data: { photoId: own, personId: florence.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const hat = await photo();
    await db.photo.update({ where: { id: hat }, data: { context: "Florence in the sun hat" } });
    const sun = await photo();
    await db.photo.update({ where: { id: sun }, data: { context: "Florence in the sun." } });
    await optOutPerson(florence.id, new FormData());
    const row = (await taggedOn(own))!;
    expect(await covers(row, hat)).toBe(true);
    expect(await covers(row, sun)).toBe(false);
  });

  it("looks nothing up when nothing forgotten is kept by place", async () => {
    // No first name to keep ("van" is a particle): nothing kept by place.
    await forget("Van Gogh");
    const ts = await loadTombstone();
    expect(ts.scoped).toBe(false);
    const client = (globalThis as unknown as { prisma: { $queryRaw: (...a: unknown[]) => unknown } }).prisma;
    const spy = vi.spyOn(client, "$queryRaw");
    const scope = await forgottenScope({ photoIds: [await photo()] }, ts);
    expect(scope.rows.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never keeps a first name taken from a full one", async () => {
    const on = await forget("Florence Adams");
    const ts = await loadTombstone();
    // On her own photograph strictly; elsewhere only the full name.
    expect(ts.scrub("Train to Florence to see the Duomo; florence adams waved", await sc(on))).toBe("Train to a family member to see the Duomo; a family member waved");
    expect(ts.scrub("Train to Florence to see the Duomo; florence adams waved", await sc(await photo()))).toBe("Train to Florence to see the Duomo; a family member waved");
  });

  it("titles the stand-in only in a title in title case", async () => {
    await forget("Timothy Kent");
    expect((await loadTombstone()).scrub("Trip: Timothy Kent, 2019")).toBe("Trip: a family member, 2019");
  });

  it("can be allowed again by an admin, by its place in the list or by typing it, without the list saying what it is", async () => {
    await forget("Ximena");
    await forget("Robin Hood");
    const list = await forgottenNames();
    // "Ximena", "Robin Hood", and Robin Hood's "Robin" (kept only on his photographs).
    expect(list.length).toBe(3);
    expect(JSON.stringify(list)).not.toMatch(/ximena|robin/i);
    // Each row reads differently, still without the name: its place in the list and its shape.
    const labels = list.map((f, i) => forgottenNameLabel(f, i, list.length, "UTC"));
    expect(new Set(labels).size).toBe(3);
    expect(labels.join("\n")).not.toMatch(/ximena|robin/i);
    expect(labels.some((l) => l.includes("a full name"))).toBe(true);
    expect(labels.some((l) => l.includes("the first name of a full name"))).toBe(true);
    expect(labels[0]).toMatch(/^1 of 3 · /);
    const fd = new FormData();
    fd.set("name", "robin  hood");
    await allowForgottenNameTyped(fd);
    expect((await loadTombstone()).scrub("Robin Hood rode")).toBe("Robin Hood rode");
    expect((await forgottenNames()).length).toBe(2);
    for (const f of await forgottenNames()) await allowForgottenName(f.hash);
    expect((await loadTombstone()).empty).toBe(true);
  });
});

describe("forgetting while FORGET_KEY is missing", () => {
  it("switches them off and scrubs the helper's text at once, and forgets them once the key is there", async () => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
    who.role = "ADMIN";
    who.id = admin;
    const p = await db.person.create({ data: { name: "Timothy Kent", faceIndexing: true, nameInDescriptions: true, createdById: admin } });
    const on = (await db.photo.create({ data: { uploaderId: admin, originalName: "t.jpg", mimeType: "image/jpeg", storageKey: "t", originalPath: "t/o.jpg", sizeBytes: 1, status: "READY", annotation: record({ caption: "Timothy Kent fishing" }), annotatedAt: new Date() } })).id;
    await db.face.create({ data: { photoId: on, personId: p.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const state = vi.spyOn(await import("@/lib/people/tombstone"), "forgetKeyState");
    state.mockResolvedValueOnce({ keys: [], write: null, problem: "FORGET_KEY is not set", paused: false, weak: 0, invalid: false });
    await optOutPerson(p.id, new FormData());
    const waiting = await db.person.findUniqueOrThrow({ where: { id: p.id } });
    expect(waiting).toMatchObject({ faceIndexing: false, nameInDescriptions: false, forgetPendingById: admin });
    expect(waiting.forgetPendingAt).not.toBeNull();
    expect(((await db.photo.findUniqueOrThrow({ where: { id: on } })).annotation as StoredAnnotation).caption).toBe("A family member fishing");
    expect(await db.forgottenName.count()).toBe(0);
    state.mockRestore();
    // Nobody left to list it for: an admin sees it.
    await db.person.update({ where: { id: p.id }, data: { forgetPendingById: null } });
    expect(await completePendingForgets()).toBe(1);
    expect(await db.person.findUnique({ where: { id: p.id } })).toBeNull();
    expect((await loadTombstone()).scrub("Timothy Kent waved")).toBe("A family member waved");
  });

  it("makes one salt when two first uses race", async () => {
    await resetTestDb();
    await db.appSetting.deleteMany();
    const [a, b] = await Promise.all([forgetKeyState(), forgetKeyState()]);
    expect(a.keys[0].key.equals(b.keys[0].key)).toBe(true);
  });
});
