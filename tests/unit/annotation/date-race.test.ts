import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

/**
 * Something a member does between the moment `applyAnnotation` reads the item and the moment it writes the answer.
 * The judgement of the answer's words sits exactly there, so it stands in for "meanwhile".
 */
const meanwhile = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));
vi.mock("@/lib/annotation/members-only", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/annotation/members-only")>();
  return {
    ...real,
    judgeHelperText: async (...args: Parameters<typeof real.judgeHelperText>) => {
      const run = meanwhile.run;
      meanwhile.run = null;
      if (run) await run();
      return real.judgeHelperText(...args);
    },
  };
});

import { annotationSchema } from "@/lib/annotation/schema";
import { applyAnnotation } from "@/lib/annotation/apply";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/annotation-response.json"), "utf8"));
const answer = annotationSchema.parse({ ...fixture, estimatedYear: { from: 1990, to: 1994, confidence: 0.8, evidence: "print border" } });

/** A date a member set or settled while the helper's answer was on its way is never replaced by its guess. */
describe("a date guess that arrives after a member dated the item", () => {
  let photoId: string, memberId: string;
  const photo = () => db.photo.findUniqueOrThrow({ where: { id: photoId } });
  beforeEach(async () => {
    await resetTestDb();
    meanwhile.run = null;
    memberId = (await db.user.create({ data: { email: "a@example.com" } })).id;
    photoId = (await db.photo.create({ data: { uploaderId: memberId, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date("2024-05-01T10:00:00Z"), takenAtSource: "FILE_MTIME" } })).id;
  });

  it("records the guess when nothing happened in between", async () => {
    await applyAnnotation(photoId, "claude-opus-5", answer, {});
    const p = await photo();
    expect(p.estimatedDateSource).toBe("MODEL");
    expect(p.estimatedDate?.getUTCFullYear()).toBe(1992);
  });

  it("leaves a date set by hand alone, and still stores the rest of the answer", async () => {
    // What a member setting the date writes: a date of their own, and who set it.
    meanwhile.run = async () => void (await db.photo.update({ where: { id: photoId }, data: { takenAt: new Date("1987-07-04T12:00:00Z"), takenAtSource: "MANUAL", dateSetById: memberId } }));
    await applyAnnotation(photoId, "claude-opus-5", answer, {});
    const p = await photo();
    expect(p).toMatchObject({ takenAtSource: "MANUAL", dateSetById: memberId, estimatedDate: null, estimatedDateSource: null, estimatedDateNote: null });
    expect(p.annotatedAt).not.toBeNull();
    expect((p.annotation as { caption: string }).caption).toBe(fixture.caption);
  });

  it("leaves an estimate a member settled alone, and still stores the rest of the answer", async () => {
    meanwhile.run = async () => void (await db.photo.update({ where: { id: photoId }, data: { estimatedDate: new Date("1980-07-01T00:00:00Z"), estimatedDateSource: "MEMBER", estimatedDateNote: null, estimatedDateConfidence: null } }));
    await applyAnnotation(photoId, "claude-opus-5", answer, {});
    const p = await photo();
    expect(p.estimatedDateSource).toBe("MEMBER");
    expect(p.estimatedDate?.getUTCFullYear()).toBe(1980);
    expect(p.estimatedDateNote).toBeNull();
    expect(p.annotatedAt).not.toBeNull();
    expect(await db.mediaAnnotationRaw.count({ where: { photoId } })).toBe(1);
  });
});
