import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ role: "MEMBER" as "MEMBER" | "ADMIN", id: "" }));
const annotated = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "x@example.com", name: null, role: who.role }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/jobs/handlers/match-photo", () => ({ enqueueMatch: async () => undefined }));
vi.mock("@/lib/jobs/handlers/annotation-sweep", () => ({ enqueueAnnotation: async (ids: string[]) => { annotated.ids.push(...ids); return ids.length; } }));

import { markReviewed, setContext } from "@/app/review/actions";

describe("notes and review on the review screen follow whose photograph it is", () => {
  let a: string, b: string, aPhoto: string, bPhoto: string;
  beforeEach(async () => {
    await resetTestDb();
    annotated.ids = [];
    a = (await db.user.create({ data: { email: "a@example.com" } })).id;
    b = (await db.user.create({ data: { email: "b@example.com" } })).id;
    const photo = (uploaderId: string, name: string) => db.photo.create({ data: { uploaderId, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", context: `${name} notes` } });
    aPhoto = (await photo(a, "a.jpg")).id;
    bPhoto = (await photo(b, "b.jpg")).id;
    who.role = "MEMBER";
    who.id = b;
  });

  it("a member cannot wipe or replace somebody else's notes, only their own", async () => {
    expect(await setContext([aPhoto, bPhoto], "", "replace")).toEqual({ n: 1, notYours: 1 });
    expect((await db.photo.findUniqueOrThrow({ where: { id: aPhoto } })).context).toBe("a.jpg notes");
    expect((await db.photo.findUniqueOrThrow({ where: { id: bPhoto } })).context).toBeNull();
    expect(await setContext([aPhoto], "mine now", "append")).toEqual({ n: 0, notYours: 1 });
    expect((await db.photo.findUniqueOrThrow({ where: { id: aPhoto } })).context).toBe("a.jpg notes");
  });

  it("a member marks only their own reviewed, and starts the helper on nothing else", async () => {
    expect(await markReviewed([aPhoto, bPhoto])).toEqual({ n: 1, notYours: 1 });
    expect((await db.photo.findUniqueOrThrow({ where: { id: aPhoto } })).reviewedAt).toBeNull();
    expect((await db.photo.findUniqueOrThrow({ where: { id: bPhoto } })).reviewedAt).not.toBeNull();
    expect(annotated.ids).toEqual([bPhoto]);
  });

  it("an admin may do both for anybody", async () => {
    who.role = "ADMIN";
    expect(await setContext([aPhoto], "at the lake", "append")).toEqual({ n: 1, notYours: 0 });
    expect((await db.photo.findUniqueOrThrow({ where: { id: aPhoto } })).context).toBe("a.jpg notes\nat the lake");
    expect(await markReviewed([aPhoto])).toEqual({ n: 1, notYours: 0 });
  });
});
