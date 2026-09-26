import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { searchMedia } from "@/lib/search/query";
import { idsMatching } from "@/lib/photos/page";
import { applyAnnotation } from "@/lib/annotation/apply";
import { applyPlaceEstimate } from "@/lib/annotation/place";
import { annotationSchema } from "@/lib/annotation/schema";
import { writtenFromMembersOnly } from "@/lib/annotation/members-only";
import type { Viewer } from "@/lib/auth/viewer";
import { resetTestDb } from "../helpers/reset";

const anon: Viewer = { kind: "anonymous", user: null, shareTokens: new Map() };
const record = (over: Record<string, unknown> = {}) =>
  annotationSchema.parse({ title: "Mail boat lunch", caption: "Lobster rolls on the mail boat", description: "Lunch on the deck.", tags: ["boat"], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "boat lunch", estimatedYear: null, estimatedPlace: null, ...over });

describe("what strangers may search, container by container, and the words' scope", () => {
  let dana: string, member: Viewer;
  const photo = (data: Record<string, unknown>) => db.photo.create({ data: { uploaderId: dana, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });

  beforeEach(async () => {
    await resetTestDb();
    const u = await db.user.create({ data: { email: "dana@example.com", name: "Dana", role: "MEMBER" } });
    dana = u.id;
    member = { kind: "user", user: { id: dana, email: u.email, name: u.name, role: "MEMBER" }, shareTokens: new Map() };
  });

  it("lets strangers search by a public collection's title only, and moves a title between columns as the collection changes", async () => {
    const trip = await db.trip.create({ data: { slug: "t", title: "Coast", visibility: "PUBLIC", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id, caption: "Rocks" });
    const secret = await db.collection.create({ data: { slug: "s", title: "Hospital visits", createdById: dana } });
    await db.collectionItem.create({ data: { collectionId: secret.id, photoId: p.id, addedById: dana } });
    expect(await searchMedia(anon, { q: "hospital" }, 120, null)).toEqual([]);
    expect((await searchMedia(member, { q: "hospital" }, 120, null)).map((h) => h.id)).toEqual([p.id]);
    await db.collection.update({ where: { id: secret.id }, data: { visibility: "PUBLIC" } });
    expect((await searchMedia(anon, { q: "hospital" }, 120, null)).map((h) => h.id)).toEqual([p.id]);
    await db.collection.update({ where: { id: secret.id }, data: { visibility: "LINK", shareToken: "tok" } });
    expect(await searchMedia(anon, { q: "hospital" }, 120, null)).toEqual([]);
  });

  it("gives a stranger's hit no title where the only one is the helper's members-only title, and members find it by that title", async () => {
    const trip = await db.trip.create({ data: { slug: "t", title: "Coast", visibility: "PUBLIC", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id, caption: "Rocks at dusk", context: "Nana's favorite spot" });
    await applyAnnotation(p.id, "m", record({ title: "Nana's lookout", caption: "The lookout" }), {});
    const [hit] = await searchMedia(anon, { q: "rocks" }, 120, null);
    expect(hit.title).toBeNull();
    // "lookout" is only in the members-only title (and the helper's members-only caption).
    expect(await searchMedia(anon, { q: "lookout" }, 120, null)).toEqual([]);
    expect((await searchMedia(member, { q: "lookout" }, 120, null))[0].title).toBe("Nana's lookout");
    expect(await idsMatching("lookou", { member: true })).toEqual([p.id]);
    expect(await idsMatching("lookou", { member: false })).toEqual([]);
  });

  it("scopes the words to public items, a collection, or items on the map, and ranks the best first", async () => {
    const pub = await db.trip.create({ data: { slug: "p", title: "Public", visibility: "PUBLIC", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const priv = await db.trip.create({ data: { slug: "q", title: "Private", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const weak = await photo({ tripId: pub.id, caption: "A pier", context: null, lat: 1, lng: 1 });
    await db.photo.update({ where: { id: weak.id }, data: { placeName: "harbor" } });
    const strong = await photo({ tripId: pub.id, caption: "Harbor, harbor, harbor at dawn", title: "Harbor" });
    const hidden = await photo({ tripId: priv.id, caption: "Harbor again" });
    const col = await db.collection.create({ data: { slug: "c", title: "C", createdById: dana } });
    await db.collectionItem.create({ data: { collectionId: col.id, photoId: hidden.id, addedById: dana } });
    expect((await idsMatching("harbor", { member: false, scope: { publicOnly: true } })).sort()).toEqual([weak.id, strong.id].sort());
    expect(await idsMatching("harbor", { member: true, scope: { collectionId: col.id } })).toEqual([hidden.id]);
    expect(await idsMatching("harbor", { member: true, scope: { tripId: pub.id, placed: true } })).toEqual([weak.id]);
    // The caption and title say it three times over; the place once.
    expect(await idsMatching("harbor", { member: true, scope: { tripId: pub.id } })).toEqual([strong.id, weak.id]);
    expect(await idsMatching("harbor", { member: true, scope: { tripId: pub.id }, limit: 1 })).toEqual([strong.id]);
  });

  it("looks for a % or an _ as typed", async () => {
    const a = await photo({ caption: "100% sure" });
    await photo({ caption: "100 percent" });
    expect(await idsMatching("0%", { member: true })).toEqual([a.id]);
    expect(await idsMatching("_", { member: true })).toEqual([]);
  });

  it("keeps text for members when anybody is tagged on the photograph, a face as much as a pet", async () => {
    const p = await photo({});
    expect(await writtenFromMembersOnly(p.id, record(), null)).toBe(false);
    const ada = await db.person.create({ data: { name: "Ada", createdById: dana } });
    await db.face.create({ data: { photoId: p.id, personId: ada.id, box: {}, confidence: 1, status: "CONFIRMED" } });
    expect(await writtenFromMembersOnly(p.id, record(), null)).toBe(true);
  });

  it("judges an answer by what its request carried, whatever has changed since", async () => {
    const p = await photo({});
    // Notes and names were sent; by the time the answer lands both are gone, and it is still the family's.
    await applyAnnotation(p.id, "m", record(), {}, { sent: true });
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, title: null, membersTitle: "Mail boat lunch" });
  });

  it("keeps the helper's text for members when it repeats the title of a trip strangers cannot open", async () => {
    const priv = await db.trip.create({ data: { slug: "q", title: "Hopkins weekend", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: priv.id });
    await applyAnnotation(p.id, "m", record({ description: "Coffee at Hopkins before the appointment." }), {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: p.id } })).annotationMembersOnly).toBe(true);
    const q = await photo({ tripId: priv.id });
    await applyAnnotation(q.id, "m", record(), {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: q.id } })).annotationMembersOnly).toBe(false);
  });

  it("keeps the name and reasons of a guessed place for members when they came from notes or name somebody", async () => {
    const guess = { name: "Towson, Maryland", precision: "city" as const, lat: 39.4, lng: -76.6, radiusM: 5000, confidence: 0.8, evidence: "the church spire" };
    const plain = await photo({});
    await applyPlaceEstimate(plain.id, guess);
    expect((await db.photo.findUniqueOrThrow({ where: { id: plain.id } })).placeEstimateMembersOnly).toBe(false);
    const noted = await photo({ context: "at Nana's in Towson" });
    await applyPlaceEstimate(noted.id, guess);
    expect((await db.photo.findUniqueOrThrow({ where: { id: noted.id } })).placeEstimateMembersOnly).toBe(true);
    const named = await photo({});
    await applyPlaceEstimate(named.id, { ...guess, evidence: "Dana's street sign" });
    expect((await db.photo.findUniqueOrThrow({ where: { id: named.id } })).placeEstimateMembersOnly).toBe(true);
  });

  it("re-judges what was written before a name was known, when somebody is added or renamed", async () => {
    const trip = await db.trip.create({ data: { slug: "t", title: "Coast", visibility: "PUBLIC", description: "A week with Biscuit.", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), createdById: dana } });
    const p = await photo({ tripId: trip.id });
    await applyAnnotation(p.id, "m", record({ title: "Biscuit on the boat", caption: "Biscuit on the deck" }), {});
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: false, title: "Biscuit on the boat" });
    await db.person.create({ data: { name: "Biscuit", kind: "PET", createdById: dana } });
    expect(await db.photo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ annotationMembersOnly: true, title: null, membersTitle: "Biscuit on the boat" });
    expect((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).descriptionMembersOnly).toBe(true);
    expect(await searchMedia(anon, { q: "biscuit" }, 120, null)).toEqual([]);

    // A rename is judged the same way: "Rex" was a word nobody was called until now.
    const q = await photo({ tripId: trip.id });
    await applyAnnotation(q.id, "m", record({ caption: "Rex asleep on the deck" }), {});
    expect((await db.photo.findUniqueOrThrow({ where: { id: q.id } })).annotationMembersOnly).toBe(false);
    await db.user.update({ where: { id: dana }, data: { name: "Rex" } });
    expect((await db.photo.findUniqueOrThrow({ where: { id: q.id } })).annotationMembersOnly).toBe(true);
  });
});
