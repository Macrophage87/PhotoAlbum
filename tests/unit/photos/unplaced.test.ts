import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { unplacedForTray } from "@/lib/photos/unplaced";
import { resetTestDb } from "../helpers/reset";

describe("what is waiting to be put on the map", () => {
  let me: { id: string; email: string; name: string | null; role: "MEMBER" }, you: typeof me, admin: { id: string; email: string; name: string | null; role: "ADMIN" };
  let tripId: string, nowhere: string, guessed: string, placed: string, yours: string;

  beforeEach(async () => {
    await resetTestDb();
    const mine = await db.user.create({ data: { email: "me@example.com" } });
    const theirs = await db.user.create({ data: { email: "you@example.com" } });
    const boss = await db.user.create({ data: { email: "jo@example.com", role: "ADMIN" } });
    me = { id: mine.id, email: mine.email, name: null, role: "MEMBER" };
    you = { id: theirs.id, email: theirs.email, name: null, role: "MEMBER" };
    admin = { id: boss.id, email: boss.email, name: null, role: "ADMIN" };
    tripId = (await db.trip.create({ data: { slug: "acadia", title: "Acadia", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-16"), createdById: me.id } })).id;
    const photo = (uploaderId: string, name: string, extra: Record<string, unknown> = {}) =>
      db.photo.create({ data: { tripId, uploaderId, originalName: name, mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", takenAt: new Date("2025-08-12T12:00:00Z"), takenAtSource: "EXIF_OFFSET", tzOffsetMin: 0, ...extra } });
    nowhere = (await photo(me.id, "nowhere.jpg")).id;
    guessed = (await photo(me.id, "guessed.jpg", { lat: 44.3, lng: -68.2, gpsSource: "ESTIMATE", placeEstimateName: "Bar Harbor" })).id;
    placed = (await photo(me.id, "placed.jpg", { lat: 44.4, lng: -68.3, gpsSource: "EXIF" })).id;
    yours = (await photo(you.id, "yours.jpg")).id;
  });

  it("offers what has no place, and what the helper only guessed at", async () => {
    const { photos, total } = await unplacedForTray(me);
    const ids = photos.map((p) => p.id);
    expect(ids).toContain(nowhere);
    expect(ids).toContain(guessed);
    expect(ids).not.toContain(placed);
    expect(total).toBe(2);
    // A guess is labelled with what it guessed, so a member knows what they are correcting.
    expect(photos.find((p) => p.id === guessed)?.guess).toBe("Bar Harbor");
    expect(photos.find((p) => p.id === nowhere)?.guess).toBeNull();
  });

  it("offers a member only their own, and an admin everyone's", async () => {
    expect((await unplacedForTray(me)).photos.map((p) => p.id)).not.toContain(yours);
    expect((await unplacedForTray(you)).photos.map((p) => p.id)).toEqual([yours]);
    const all = (await unplacedForTray(admin)).photos.map((p) => p.id);
    expect(all).toContain(nowhere);
    expect(all).toContain(yours);
  });

  it("can be held to one trip, and pages", async () => {
    const other = await db.trip.create({ data: { slug: "yosemite", title: "Yosemite", startDate: new Date("2025-09-01"), endDate: new Date("2025-09-05"), createdById: me.id } });
    await db.photo.create({ data: { tripId: other.id, uploaderId: me.id, originalName: "far.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } });
    expect((await unplacedForTray(me, { tripId })).total).toBe(2);
    expect((await unplacedForTray(me, { tripId: other.id })).total).toBe(1);
    const page = await unplacedForTray(me, { tripId, take: 1 });
    expect(page.photos).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });
});
