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
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { optOutPerson } from "@/app/people/actions";
import { applyAnnotation } from "@/lib/annotation/apply";
import { applyPlaceEstimate } from "@/lib/annotation/place";
import { loadItem, withoutUnpermittedNames } from "@/lib/annotation/request";
import { withoutUnpermittedNames as withoutContainerNames } from "@/lib/annotation/container";
import { loadTombstone } from "@/lib/people/tombstone";

const record = (over: Partial<StoredAnnotation> = {}) =>
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
});
