import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";
import { unreviewedPage } from "@/lib/review/queue";

/** The Unreviewed queue a page at a time (#12): a Takeout import of a decade must not land on one page. */
describe("the Unreviewed queue, a page at a time", () => {
  let admin: { id: string; role: "ADMIN" };
  let member: { id: string; role: "MEMBER" };
  beforeEach(async () => {
    await resetTestDb();
    admin = { id: (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id, role: "ADMIN" };
    member = { id: (await db.user.create({ data: { email: "m@example.com", role: "MEMBER" } })).id, role: "MEMBER" };
    const base = Date.parse("2026-01-01T00:00:00Z");
    // Seven of the member's, two of the admin's, all made in the same second as some others to test the tie-break.
    for (let i = 0; i < 9; i++) {
      await db.photo.create({ data: { uploaderId: i < 7 ? member.id : admin.id, status: "READY", originalName: `p${i}.jpg`, mimeType: "image/jpeg", storageKey: `photos/${i}`, originalPath: `photos/${i}/original.jpg`, sizeBytes: 1, createdAt: new Date(base + Math.floor(i / 2) * 1000) } });
    }
    await db.photo.create({ data: { uploaderId: member.id, status: "READY", originalName: "done.jpg", mimeType: "image/jpeg", storageKey: "photos/d", originalPath: "photos/d/original.jpg", sizeBytes: 1, reviewedAt: new Date() } });
  });

  it("walks every unreviewed item once, newest first, and stops", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { photos: { originalName: string }[]; nextCursor: string | null } = await unreviewedPage(admin, { originalName: true }, { cursor, take: 4 });
      seen.push(...page.photos.map((p) => p.originalName));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(9);
    expect(seen.slice(0, 1)).toEqual(["p8.jpg"]);
    expect(seen).not.toContain("done.jpg");
  });

  it("gives a member only their own uploads", async () => {
    const page = await unreviewedPage(member, { uploaderId: true }, { take: 100 });
    expect(page.photos).toHaveLength(7);
    expect(page.nextCursor).toBeNull();
  });

  it("re-reads named items, leaving out any reviewed since", async () => {
    const [first] = (await unreviewedPage(admin, {}, { take: 1 })).photos;
    expect((await unreviewedPage(admin, {}, { ids: [first.id], take: 1 })).photos.map((p) => p.id)).toEqual([first.id]);
    await db.photo.update({ where: { id: first.id }, data: { reviewedAt: new Date() } });
    expect((await unreviewedPage(admin, {}, { ids: [first.id], take: 1 })).photos).toEqual([]);
  });
});
