import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { annotationSchema, toStored } from "@/lib/annotation/schema";
import { applyAnnotation } from "@/lib/annotation/apply";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/annotation-response.json"), "utf8"));
const answer = annotationSchema.parse({ ...fixture, caption: "The helper's caption", searchSummary: "fresh summary from the helper" });
const sharedAt = new Date("2026-09-01T12:00:00Z");

/** A member's edited words that they showed to everyone stay shown through a background pass. */
describe("a background pass over edited text a member shared", () => {
  let photoId: string;
  const photo = () => db.photo.findUniqueOrThrow({ where: { id: photoId } });
  let userId: string;
  async function stage(caption: string, extra: Record<string, unknown> = {}) {
    const theirs = { ...toStored(annotationSchema.parse(fixture)), caption, searchSummary: "the summary they read" };
    photoId = (await db.photo.create({ data: { uploaderId: userId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation: theirs, annotationSource: "EDITED", annotationMembersOnly: false, annotationSharedAt: sharedAt, ...extra } })).id;
  }
  beforeEach(async () => {
    await resetTestDb();
    userId = (await db.user.create({ data: { email: "a@example.com" } })).id;
  });

  it("keeps it shared, keeps their words, and refreshes the helper's own fields", async () => {
    await stage("Boats in the harbor at dawn");
    await applyAnnotation(photoId, "claude-opus-5", answer, {});
    const p = await photo();
    expect(p).toMatchObject({ annotationSource: "EDITED", annotationMembersOnly: false, annotationSharedAt: sharedAt });
    expect(p.annotation).toMatchObject({ caption: "Boats in the harbor at dawn", searchSummary: "fresh summary from the helper" });
  });

  it("keeps it shared, but does not publish refreshed helper words written from the family's notes", async () => {
    await stage("Boats in the harbor at dawn", { context: "Uncle Theo's boat, the morning after the wedding" });
    await applyAnnotation(photoId, "claude-opus-5", answer, {});
    const p = await photo();
    expect(p).toMatchObject({ annotationMembersOnly: false, annotationSharedAt: sharedAt });
    expect(p.annotation).toMatchObject({ caption: "Boats in the harbor at dawn", searchSummary: "the summary they read" });
  });

  it("holds it for the family again when their words now name somebody", async () => {
    await db.person.create({ data: { name: "Ada Quillfeather", createdById: userId } });
    await stage("Ada Quillfeather on the boat");
    await applyAnnotation(photoId, "claude-opus-5", answer, {});
    const p = await photo();
    expect(p).toMatchObject({ annotationMembersOnly: true, annotationSharedAt: null });
  });
});
