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
import { forgetKeyState, forgottenNames, forgottenScope, loadTombstone } from "@/lib/people/tombstone";
import { completePendingForgets } from "@/lib/people/forget-person";
import { withForgetLock } from "@/lib/people/names-changed";
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

  it("is thrown away only while a forget is under way, or about a photograph the forget touched", async () => {
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

  it("stamps a photograph whose members' words name them, and takes the name out of what the helper wrote there", async () => {
    await db.photo.update({ where: { id: photoId }, data: { annotation: record({ caption: "Timothy by the river", description: "Timothy Kent casts a line." }), annotatedAt: new Date() } });
    await forget();
    const p = await db.photo.findUniqueOrThrow({ where: { id: photoId } });
    expect(p.namesScrubbedAt).not.toBeNull();
    expect((p.annotation as StoredAnnotation).description).toBe("A family member casts a line.");
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

  it("stamp every photograph in a trip whose title names them", async () => {
    const kent = await db.person.create({ data: { name: "Timothy Kent", createdById: admin } });
    const trip = await db.trip.create({ data: { slug: "bday", title: "Timothy Kent's 5th birthday", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-01"), createdById: admin } });
    const plain = (await db.photo.create({ data: { uploaderId: admin, originalName: "p.jpg", mimeType: "image/jpeg", storageKey: "p", originalPath: "p/o.jpg", sizeBytes: 1, status: "READY", tripId: trip.id } })).id;
    await optOutPerson(kent.id, new FormData());
    expect((await db.photo.findUniqueOrThrow({ where: { id: plain } })).namesScrubbedAt).not.toBeNull();
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

  it("keeps a one-word name to the photographs they were on, as a name is written", async () => {
    const on = await forget("Ximena");
    const ts = await loadTombstone();
    expect(ts.scrub("Ximena waved; ximena waved", await sc(on))).toBe("A family member waved; ximena waved");
    expect(ts.scrub("HAPPY BIRTHDAY XIMENA", await sc(on))).toBe("HAPPY BIRTHDAY A FAMILY MEMBER");
    // Anywhere else only full names count.
    expect(ts.scrub("Ximena waved", await sc(await photo()))).toBe("Ximena waved");
    expect(ts.scrub("Ximena waved")).toBe("Ximena waved");
    // No "a a family member": the article goes with the name.
    expect(ts.scrub("We met a Ximena at the fair", await sc(on))).toBe("We met a family member at the fair");
  });

  it("never keeps a one-word name that is a month, an everyday word, a herb or a bird", async () => {
    for (const n of ["June", "May", "Grace", "Jack", "Will", "Sage", "Basil", "Robin", "Rosemary", "Wren", "Holly"]) await forget(n);
    expect(await db.forgottenName.count()).toBe(0);
    const ts = await loadTombstone();
    for (const t of ["Our trip in June", "Taken in May 2019", "Amazing Grace", "Grace Bay", "Union Jack", "Jack Russell", "Will you come?", "Sage green walls.", "Robin Hood"]) expect(ts.scrub(t)).toBe(t);
    const other = await photo();
    await applyAnnotation(other, "m", record({ caption: "Our trip in June", estimatedYear: { from: 2019, to: 2019, confidence: 0.8, evidence: "Taken in May 2019" } }), { content: [] }, { requestedAt: new Date() });
    const p = await db.photo.findUniqueOrThrow({ where: { id: other } });
    expect((p.annotation as StoredAnnotation).caption).toBe("Our trip in June");
    expect(p.estimatedDateNote).toBe("2019–2019: Taken in May 2019");
  });

  it("leaves a place alone, even on their photographs", async () => {
    const on = await forget("Florence");
    const ts = await loadTombstone();
    for (const t of ["Florence, Italy in spring.", "A trip to Florence, Italy", "Florence Nightingale statue", "The Duomo in Florence", "Florence 2019"]) expect(ts.scrub(t, await sc(on))).toBe(t);
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
    expect(ts.namesTag("ximena pool", await sc(on))).toBe(false);
    expect(ts.scrubSummary("fishing, ximena may 2019; ximena florence", await sc(on))).toBe("fishing, ximena may 2019; ximena florence");
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

  it("keeps the photographs of everybody forgotten under the same one-word name", async () => {
    const first = await forget("Ximena");
    const second = await forget("Ximena");
    expect(await db.forgottenName.count()).toBe(1);
    const ts = await loadTombstone();
    for (const on of [first, second]) expect(ts.scrub("Ximena waved", await sc(on))).toBe("A family member waved");
  });

  it("never keeps a first name taken from a full one", async () => {
    const on = await forget("Florence Adams");
    const ts = await loadTombstone();
    expect(ts.scrub("Train to Florence to see the Duomo; florence adams waved", await sc(on))).toBe("Train to Florence to see the Duomo; a family member waved");
  });

  it("titles the stand-in only in a title in title case", async () => {
    await forget("Timothy Kent");
    expect((await loadTombstone()).scrub("Trip: Timothy Kent, 2019")).toBe("Trip: a family member, 2019");
  });

  it("can be allowed again by an admin, by its place in the list or by typing it, without the list saying what it is", async () => {
    await forget("Ximena");
    await forget("Robin Hood");
    const list = await forgottenNames();
    expect(list.length).toBe(2);
    expect(JSON.stringify(list)).not.toMatch(/ximena|robin/i);
    const fd = new FormData();
    fd.set("name", "robin  hood");
    await allowForgottenNameTyped(fd);
    expect((await loadTombstone()).scrub("Robin Hood rode")).toBe("Robin Hood rode");
    await allowForgottenName((await forgottenNames())[0].hash);
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
    state.mockResolvedValueOnce({ keys: [], write: null, problem: "FORGET_KEY is not set", paused: false, weak: 0 });
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
