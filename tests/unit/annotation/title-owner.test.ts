import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { markHelperTitlesOnce } from "@/lib/annotation/title-owner";
import { resetTestDb } from "../helpers/reset";

describe("marking old helper titles that name somebody", () => {
  let me: string;
  const photo = (name: string, data: Record<string, unknown>) =>
    db.photo.create({ data: { uploaderId: me, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", ...data } }).then((p) => p.id);

  beforeEach(async () => {
    await resetTestDb();
    me = (await db.user.create({ data: { email: "x@example.com", role: "ADMIN" } })).id;
  });

  it("marks a machine-described item's title naming somebody, once, and never a member's later title", async () => {
    await db.person.create({ data: { name: "Ada Byron", createdById: me } });
    const named = await photo("a.jpg", { title: "Ada Byron on the porch", annotation: { title: "Ada Byron at the lake" }, annotationSource: "MACHINE", annotatedAt: new Date() });
    const plain = await photo("b.jpg", { title: "The porch", annotation: { title: "A porch" }, annotationSource: "MACHINE", annotatedAt: new Date() });
    const edited = await photo("c.jpg", { title: "Ada Byron's 80th", annotation: { title: "A cake" }, annotationSource: "EDITED", annotatedAt: new Date() });
    expect(await markHelperTitlesOnce()).toBe(1);
    const byHelper = async (id: string) => (await db.photo.findUniqueOrThrow({ where: { id } })).titleByHelper;
    expect([await byHelper(named), await byHelper(plain), await byHelper(edited)]).toEqual([true, false, false]);
    // A member then retitles it; the pass does not run again to take it back.
    await db.photo.update({ where: { id: named }, data: { title: "Ada Byron with the dog", titleByHelper: false } });
    expect(await markHelperTitlesOnce()).toBe(0);
    expect(await byHelper(named)).toBe(false);
  });
});
