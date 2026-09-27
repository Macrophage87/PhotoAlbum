import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

const who = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/viewer", () => ({ requireUserOrThrow: async () => ({ id: who.id, email: "admin@example.com", name: null, role: "ADMIN" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { dismissForgetLeftover } from "@/app/people/actions";
import { changeTripSlug } from "@/app/trips/[slug]/actions";
import { changeCollectionSlug } from "@/app/collections/actions";
import { forgetPerson } from "@/lib/people/forget-person";
import type { LeftoverItems } from "@/lib/people/forget";

/**
 * What forgetting somebody leaves that members typed without thinking of it as words about them: a file name, a
 * note, a web address made from a first title, what the album knows about somebody else, a track, an import's
 * report. Listed (never changed) by id and field, so whoever forgot them can see to it; the list keeps no words.
 */
describe("what a forget lists besides titles, captions and notes", () => {
  beforeEach(async () => {
    await resetTestDb();
    who.id = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const photo = (name: string, data: Record<string, unknown> = {}) => db.photo.create({ data: { uploaderId: who.id, originalName: name, mimeType: "image/jpeg", storageKey: name, originalPath: `${name}/o.jpg`, sizeBytes: 1, status: "READY", ...data } });

  it("lists file names, trash and link notes, web addresses, other people's records, tracks and import reports", async () => {
    const zeb = await db.person.create({ data: { name: "Zebulon Quince", createdById: who.id } });
    const plain = await photo("pier.jpg");
    // The place's name holds it, from the address lookup or an accepted guess: on a photograph they are tagged on,
    // and one they are not.
    const cabin = await photo("cabin.jpg", { lat: 44.3, lng: -68.2, gpsSource: "MANUAL", placeName: "Zebulon Quince's cabin" });
    await db.face.create({ data: { photoId: cabin.id, personId: zeb.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    const road = await photo("road.jpg", { lat: 44.4, lng: -68.1, gpsSource: "EXIF", placeName: "Quince Road, near Zebulon Quince's cabin" });
    const named = await photo("zebulon_quince_80th.jpg");
    const binned = await photo("dup.jpg", { trashedAt: new Date(), trashNote: "Same as Zebulon Quince's cake photo" });
    const linked = await photo("left.jpg");
    await db.photoLink.create({ data: { photoAId: linked.id, photoBId: plain.id, relation: "RELATED", note: "the other half of zebulon quince's party" } });
    const trip = await db.trip.create({ data: { slug: "zebulon-quince-80th", title: "Grandpa's 80th", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-11"), createdById: who.id } });
    const collection = await db.collection.create({ data: { slug: "for-zebulon-quince", title: "Best of the summer", createdById: who.id } });
    const other = await db.person.create({ data: { name: "Mabel", relationship: "Zebulon Quince's sister", formerNames: ["Mabel Quince"], createdById: who.id } });
    const track = await db.track.create({ data: { tripId: trip.id, uploaderId: who.id, source: "GPX", name: "Walk", originalFile: "Zebulon-Quince-walk.gpx", startTime: new Date("2025-08-10T10:00:00Z"), endTime: new Date("2025-08-10T11:00:00Z"), pointCount: 0, minLat: 0, maxLat: 0, minLng: 0, maxLng: 0, simplified: [], pointsBlob: new Uint8Array() } });
    const report = await db.takeoutImport.create({ data: { archiveName: "takeout-1.zip", startedById: who.id, report: { skipped: ["Photos from 2019/ZEBULON QUINCE 80.jpg"] } } });
    // Nothing that names nobody.
    await db.trip.create({ data: { slug: "coast", title: "Coast", startDate: new Date("2025-08-10"), endDate: new Date("2025-08-11"), createdById: who.id } });

    await forgetPerson(zeb.id, { keepName: false, byUserId: who.id });
    const [left] = await db.forgetLeftover.findMany();
    const items = left.items as LeftoverItems;
    expect(JSON.stringify(items)).not.toMatch(/zebulon|quince/i);
    expect(items.photos).toEqual(expect.arrayContaining([{ id: named.id, fields: ["file name"] }, { id: binned.id, fields: ["trash note"] }, { id: linked.id, fields: ["link note"] }]));
    expect(items.photos.map((p) => p.id)).not.toContain(plain.id);
    expect(items.photos).toEqual(expect.arrayContaining([{ id: cabin.id, fields: ["place"] }, { id: road.id, fields: ["place"] }]));
    expect(items.trips).toEqual([{ id: trip.id, fields: ["web address"] }]);
    expect(items.collections).toEqual([{ id: collection.id, fields: ["web address"] }]);
    // A former name that is only a surname they share is nobody's full name: the relationship is listed, not it.
    expect(items.people).toEqual([{ id: other.id, fields: ["relationship"] }]);
    expect(items.tracks).toEqual([{ id: track.id, fields: ["file name"] }]);
    expect(items.imports).toEqual([{ id: report.id }]);
    // Listed, never changed.
    expect((await db.photo.findUniqueOrThrow({ where: { id: named.id } })).originalName).toBe("zebulon_quince_80th.jpg");

    // The owner (or an admin) gives the trip and the collection new addresses.
    const fd = (slug: string) => { const f = new FormData(); f.set("slug", slug); return f; };
    await expect(changeTripSlug("zebulon-quince-80th", fd("Grandpa's 80th"))).rejects.toThrow("REDIRECT:/trips/grandpa-s-80th/settings?saved=1");
    await expect(changeCollectionSlug("for-zebulon-quince", fd("coast"))).rejects.toThrow("REDIRECT:/collections/coast/settings?saved=1");
    expect((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).slug).toBe("grandpa-s-80th");
    // Another trip's address is not a collection's concern; within trips it would have been made unique.
    await expect(changeTripSlug("grandpa-s-80th", fd("coast"))).rejects.toThrow("REDIRECT:/trips/coast-2/settings?saved=1");

    // Done with the list: it keeps nothing.
    await dismissForgetLeftover(left.id);
    expect(await db.forgetLeftover.findUniqueOrThrow({ where: { id: left.id } })).toMatchObject({ items: {}, dismissedById: who.id });
  });
});
