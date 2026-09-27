import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { forgetNameInText } from "@/lib/people/forget";
import { nameMatcher } from "@/lib/people/scrub";
import type { StoredAnnotation } from "@/lib/annotation/schema";

/**
 * On somebody else's photograph a forget takes out only the full name: a first name alone there is as often a place
 * or somebody else, and in a title written in title case nothing tells them apart. On their own photographs their
 * first name is still theirs.
 */
describe("what a forget rewrites on photographs they are not on", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const photo = (title: string) =>
    db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", title, titleByHelper: true, annotation: { title, caption: title, description: "", tags: [], searchSummary: "" }, placeEstimateName: title } });
  const text = async (id: string) => {
    const p = await db.photo.findUniqueOrThrow({ where: { id } });
    return [p.title, (p.annotation as StoredAnnotation).title, (p.annotation as StoredAnnotation).caption, p.placeEstimateName];
  };

  it.each([
    ["Leo Martin", "Leo Martinez Park At Dusk"],
    ["Louise Penny", "Sunrise At Lake Louise"],
    ["Barbara Jones", "Santa Barbara Pier"],
  ])("forgetting %s leaves %s alone on a photograph they are not on", async (name, words) => {
    const p = await photo(words);
    await forgetNameInText([p.id], nameMatcher([name], []), { tagged: new Set(), containers: false });
    expect(await text(p.id)).toEqual([words, words, words, words]);
  });

  it("still takes out the full name there, and a first name alone on their own photograph", async () => {
    const elsewhere = await photo("Leo Martin At The Lake");
    const theirs = await photo("Leo At The Lake");
    await forgetNameInText([elsewhere.id, theirs.id], nameMatcher(["Leo Martin"], []), { tagged: new Set([theirs.id]), containers: false });
    expect((await text(elsewhere.id)).slice(0, 3)).toEqual(["A Family Member At The Lake", "A Family Member At The Lake", "A Family Member At The Lake"]);
    expect((await text(theirs.id)).slice(0, 3)).toEqual(["A Family Member At The Lake", "A Family Member At The Lake", "A Family Member At The Lake"]);
  });
});
