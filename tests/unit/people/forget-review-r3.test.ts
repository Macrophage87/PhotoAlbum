import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The forget review of 06283c6: stamps by the database's clock and cleared by a forget, and everyday full names. */
vi.hoisted(() => {
  process.env.ANNOTATION_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "sk-test";
});
const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({
  requireUserOrThrow: async () => ({ id: who.id, email: "a@example.com", name: null, role: "ADMIN" }),
  requireAdminOrThrow: async () => ({ id: who.id, email: "a@example.com", name: null, role: "ADMIN" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";
import { untagPersonAt } from "@/app/people/actions";
import { startBackfill } from "@/app/annotation/actions";
import { forgetPerson } from "@/lib/people/forget-person";
import { dbNow } from "@/lib/people/names-changed";
import { applyAnnotation } from "@/lib/annotation/apply";
import { annotationSchema, type StoredAnnotation } from "@/lib/annotation/schema";

const record = (over: Partial<StoredAnnotation> = {}): StoredAnnotation => ({ title: "", caption: "", description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "winter", mood: null, searchSummary: "", ...over });

describe("the forget review, third round", () => {
  let admin: string;
  const photo = (data: Record<string, unknown> = {}) => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } }).then((p) => p.id);
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
    who.id = admin;
    await db.appSetting.create({ data: { id: "app", annotationOptInAt: new Date(), annotationOptInById: admin } });
  });
  afterEach(() => vi.useRealTimers());

  it("D: stamps an untagged photograph, and dates a batch, by the database's clock, not the server's", async () => {
    const ada = await db.person.create({ data: { name: "Ada Byron", createdById: admin } });
    const p = await photo({ annotation: record({ caption: "A lake" }), annotatedAt: new Date() });
    const face = await db.face.create({ data: { photoId: p, personId: ada.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    // The server's clock is a year behind the database's.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - 365 * 86_400_000));
    const before = await dbNow();
    await untagPersonAt(face.id);
    const stamp = (await db.photo.findUniqueOrThrow({ where: { id: p } })).namesScrubbedAt!;
    expect(stamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    // A backfill of the photographs not yet described: answers are judged by when it was asked for.
    await photo();
    const asked = await dbNow();
    const id = await startBackfill({ kind: "all", task: "describe" }, "1");
    expect((await db.annotationBatch.findUniqueOrThrow({ where: { id } })).createdAt.getTime()).toBeGreaterThanOrEqual(asked.getTime());
    vi.useRealTimers();
    // And an answer asked for before the stamp, by the database's clock, is thrown away.
    await db.photo.update({ where: { id: p }, data: { annotation: record({ caption: "Old" }), annotatedAt: new Date() } });
    await applyAnnotation(p, "m", annotationSchema.parse({ ...record({ caption: "Ada Byron at the lake" }), estimatedYear: null, estimatedPlace: null }), { content: [] }, { requestedAt: new Date(before.getTime() - 1000) });
    expect(((await db.photo.findUniqueOrThrow({ where: { id: p } })).annotation as StoredAnnotation).caption).toBe("Old");
  });

  it("B: a forget clears every stamp an untagging or a withdrawal left, anywhere", async () => {
    const ada = await db.person.create({ data: { name: "Ada Byron", createdById: admin } });
    const ben = await db.person.create({ data: { name: "Ben Ortiz", createdById: admin } });
    const stamped = await photo({ namesScrubbedAt: new Date() });
    const elsewhere = await photo({ namesScrubbedAt: new Date() });
    const hers = await photo();
    await db.face.create({ data: { photoId: hers, personId: ada.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await db.face.create({ data: { photoId: stamped, personId: ben.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    await forgetPerson(ada.id, { keepName: false, byUserId: admin });
    expect(await db.photo.count({ where: { namesScrubbedAt: { not: null } } })).toBe(0);
    for (const id of [stamped, elsewhere, hers]) expect((await db.photo.findUniqueOrThrow({ where: { id } })).namesScrubbedAt).toBeNull();
    // What the stamps did, the forget's own does: an answer asked for before it is thrown away.
    const setting = await db.appSetting.findUniqueOrThrow({ where: { id: "app" } });
    expect(setting.lastForgetAt).not.toBeNull();
  });

  it("C: a full name of everyday words never takes the thing out of keywords or tags on other photographs, in any case", async () => {
    const holly = await db.person.create({ data: { name: "Holly Berry", createdById: admin } });
    const hers = await photo();
    await db.face.create({ data: { photoId: hers, personId: holly.id, status: "CONFIRMED", box: [0, 0, 1, 1], confidence: 0 } });
    const summary = "holly berry wreath christmas; Holly Berry garland, HOLLY BERRY";
    const tags = ["holly berry", "Holly Berry", "HOLLY BERRY", "holly berry wreath"];
    const wreath = await photo({ annotation: record({ caption: "A wreath", searchSummary: summary, tags }), annotatedAt: new Date() });
    await forgetPerson(holly.id, { keepName: false, byUserId: admin });
    const read = async (id: string) => (await db.photo.findUniqueOrThrow({ where: { id } })).annotation as StoredAnnotation;
    expect(await read(wreath)).toMatchObject({ searchSummary: summary, tags });
    // Nor in a later answer there (tags are stored in lower case, once each).
    await applyAnnotation(wreath, "m", annotationSchema.parse({ ...record({ caption: "A wreath", searchSummary: summary, tags }), estimatedYear: null, estimatedPlace: null }), { content: [] }, { requestedAt: new Date() });
    expect(await read(wreath)).toMatchObject({ searchSummary: summary, tags: ["holly berry", "holly berry wreath"] });
    // On her own photograph, all of it.
    await applyAnnotation(hers, "m", annotationSchema.parse({ ...record({ caption: "A wreath", searchSummary: summary, tags }), estimatedYear: null, estimatedPlace: null }), { content: [] }, { requestedAt: new Date() });
    const own = await read(hers);
    expect(own.tags).toEqual([]);
    expect(own.searchSummary.toLowerCase()).not.toContain("holly");
  });
});
