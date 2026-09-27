import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { namesSomebodyRestricted } from "@/lib/people/restricted";
import { withoutWithdrawnNames } from "@/lib/people/forget";
import { strictMatcher } from "@/lib/people/strict-names";
import { mentionsAnyName } from "@/lib/annotation/names";
import { judgeDescription, judgeHelperText, knownNames, placeFromMembersOnly } from "@/lib/annotation/members-only";
import { applyAnnotation } from "@/lib/annotation/apply";
import { rejudgeTitles } from "@/lib/annotation/rejudge";
import { annotationSchema, type StoredAnnotation } from "@/lib/annotation/schema";

/**
 * The share-guard attacker's review of 06283c6: plurals and possessives without an apostrophe (B1), digits against a
 * name (S1), letters that do not decompose (S2), every path that publishes by itself (S3), "Lake"/"Mount" only as
 * written and not after "the" (N1), "this" no date word (N2), and two-letter names that are also small words.
 */
type Row = { name: string; text?: string; tags?: string[]; summary?: string };

const REFUSED: Row[] = [
  // B1
  { name: "Madison Clark", text: "Madisons at the beach" },
  { name: "Madison Clark", text: "MADISONS 5TH" },
  { name: "Madison Clark", text: "Happy 5th, Madisons!" },
  { name: "Madison Clark", tags: ["madisons birthday"] },
  { name: "Sierra Okafor", text: "The Okafors at the beach" },
  { name: "Lily Chen", text: "lilys birthday" },
  { name: "May Chen", text: "mays birthday" },
  { name: "May Chen", text: "Mays first swim" },
  // S1
  { name: "Madison Clark", text: "madison2016" },
  { name: "Madison Clark", text: "Madison2016 at the park" },
  { name: "Madison Clark", tags: ["madison2016"] },
  { name: "Madison Clark", summary: "2016madison birthday" },
  // S2, both ways
  { name: "Łukasz Nowak", text: "Lukasz at the park" },
  { name: "Lukasz Nowak", text: "Łukasz at the park" },
  { name: "Łukasz Nowak", text: "ŁUKASZ AT THE PARK" },
  { name: "Søren Berg", text: "Soren at the park" },
  { name: "Soren Berg", text: "Søren at the park" },
  { name: "Æsa Berg", text: "Aesa at the park" },
  { name: "Maßimo Rossi", text: "Massimo at the park" },
  { name: "Đorđe Ilić", text: "Dorde at the park" },
  { name: "Ingiþór Berg", text: "Ingithor at the park" },
  { name: "Iıla Berg", text: "Iila at the park" },
  // N1
  { name: "Madison Clark", text: "Sunset by the lake Madison." },
  { name: "Madison Clark", text: "Down at the lake Madison at dawn." },
  { name: "Madison Clark", text: "Down at the Lake Madison at dawn." },
  { name: "Madison Clark", text: "lake madison at dawn" },
  // N2
  { name: "May Chen", text: "Look at this May!" },
  { name: "May Chen", text: "Proud of this May." },
  // Two-letter names that are small words: written with a capital.
  { name: "An Nguyen", text: "An at the park" },
  { name: "Do Kim", text: "Do at the park" },
  { name: "Do Kim", text: "DO AT THE PARK" },
  { name: "Jo March", text: "Jo at the park" },
];

const SHARED: Row[] = [
  { name: "An Nguyen", text: "an apple at the park" },
  { name: "Al Brown", text: "Dinner al fresco." },
  { name: "Do Kim", text: "we do the dishes" },
  { name: "Madison Clark", text: "Lake Madison at dawn." },
  { name: "May Chen", text: "Back in May." },
  { name: "May Chen", text: "The 5th of May." },
];

const record = (r: Row): StoredAnnotation => ({ title: "", caption: r.text ?? "", description: "", tags: r.tags ?? [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: r.summary ?? "" });
const label = (r: Row) => `${r.name}: ${JSON.stringify(r.text ?? r.tags ?? r.summary)}`;
const words = (r: Row) => [r.text, r.summary, ...(r.tags ?? [])];

describe("the share guard, third review", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const child = (name: string) => db.person.create({ data: { name, birthday: new Date("2016-05-01"), createdById: admin } });
  const photo = (data: Record<string, unknown> = {}) => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", ...data } });

  it.each(REFUSED.map((r) => [label(r), r] as const))("refuses %s, for a child and a withdrawn naming, on her photograph or not", async (_, r) => {
    const person = await child(r.name);
    expect(await namesSomebodyRestricted(words(r))).toBe(true);
    await db.person.update({ where: { id: person.id }, data: { birthday: null, namingWithdrawnAt: new Date() } });
    expect(await namesSomebodyRestricted(words(r))).toBe(true);
    const away = await photo({ annotation: record(r) });
    const own = await photo({ annotation: record(r) });
    await db.face.create({ data: { photoId: own.id, personId: person.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    for (const p of [away, own]) {
      const shown = await withoutWithdrawnNames(p.id, { annotation: record(r), title: null });
      const a = shown.annotation as StoredAnnotation;
      const published = shown.hold ? [] : [a.caption, a.searchSummary, ...a.tags];
      expect(published.filter((w) => strictMatcher([r.name])(w))).toEqual([]);
    }
  });

  it.each(SHARED.map((r) => [label(r), r] as const))("shares %s", async (_, r) => {
    await child(r.name);
    expect(await namesSomebodyRestricted(words(r))).toBe(false);
  });

  it("finds letters that do not decompose either way round, and digits against a name, in the members-only look too", () => {
    for (const [name, text] of [["Łukasz Nowak", "Lukasz waves"], ["Lukasz Nowak", "Łukasz waves"], ["Søren Berg", "Soren waves"], ["Soren Berg", "Søren waves"], ["Madison Clark", "madison2016"]]) expect([name, text, mentionsAnyName(text, [name])]).toEqual([name, text, true]);
  });

  /** S3: text strangers would read, written by the helper or kept by a member, that only the strict guard sees. */
  describe("every path that publishes by itself asks the strict guard too", () => {
    // "MAY" in capitals is no name to the members-only matcher; to the strict guard it is May Chen, a child.
    const SAID = "Happy birthday MAY";
    const adult = () => db.person.create({ data: { name: "May Chen", birthday: new Date("1980-05-01"), createdById: admin } });

    it("judgeHelperText", async () => {
      await child("May Chen");
      expect(mentionsAnyName(SAID, await knownNames())).toBe(false);
      const p = await photo();
      const text = { title: "", caption: SAID, description: "", searchSummary: "", place: null, tags: [] };
      expect((await judgeHelperText(p.id, text, null, false)).membersOnly).toBe(true);
      await db.person.updateMany({ data: { birthday: new Date("1980-05-01") } });
      expect((await judgeHelperText(p.id, text, null, false)).membersOnly).toBe(false);
    });

    it("judgeDescription", async () => {
      await child("May Chen");
      expect((await judgeDescription(SAID, { names: [], notes: false })).membersOnly).toBe(true);
      await db.person.updateMany({ data: { birthday: new Date("1980-05-01") } });
      expect((await judgeDescription(SAID, { names: [], notes: false })).membersOnly).toBe(false);
    });

    it("placeFromMembersOnly", async () => {
      await child("May Chen");
      const p = await photo();
      const place = { name: "Grandma's garden", evidence: `A banner reads ${SAID.toUpperCase()}` };
      expect(await placeFromMembersOnly(p.id, place, null, false)).toBe(true);
      await db.person.updateMany({ data: { birthday: new Date("1980-05-01") } });
      expect(await placeFromMembersOnly(p.id, place, null, false)).toBe(false);
    });

    it("a member's shared words kept through a new answer (apply.ts, sharedStays)", async () => {
      const shared = async () => {
        const p = await photo({ annotation: { ...record({ name: "", text: SAID }), description: "Cake on the porch." }, annotationSource: "EDITED", annotationMembersOnly: false, annotationSharedAt: new Date(), annotatedAt: new Date() });
        await applyAnnotation(p.id, "m", annotationSchema.parse({ ...record({ name: "", text: "A cake" }), title: "Cake", estimatedYear: null, estimatedPlace: null }), { content: [] }, { requestedAt: new Date() });
        return db.photo.findUniqueOrThrow({ where: { id: p.id } });
      };
      const person = await adult();
      // An adult's "MAY" stays as the member shared it.
      expect(await shared()).toMatchObject({ annotationMembersOnly: false });
      await db.person.update({ where: { id: person.id }, data: { birthday: new Date("2016-05-01") } });
      const held = await shared();
      expect(held.annotationSharedAt).toBeNull();
      expect(held.annotationMembersOnly).toBe(true);
    });

    it("the title-only lift of the rejudge sweep", async () => {
      const trip = await db.trip.create({ data: { slug: "tahoe", title: "Tahoe weekend", startDate: new Date("2025-01-01"), endDate: new Date("2025-01-02"), visibility: "PUBLIC", createdById: admin } });
      const held = () => photo({ tripId: trip.id, annotation: { ...record({ name: "", text: `Skiing at Tahoe. ${SAID}` }), title: "Skiing at Tahoe" }, annotatedAt: new Date(), annotationMembersOnly: true, annotationTitleOnly: true, annotationTitleWords: ["tahoe"], annotationTitleFrom: [`trip:${trip.id}`] });
      const person = await adult();
      const lifted = await held();
      await rejudgeTitles({ tripId: trip.id });
      expect((await db.photo.findUniqueOrThrow({ where: { id: lifted.id } })).annotationMembersOnly).toBe(false);
      await db.person.update({ where: { id: person.id }, data: { birthday: new Date("2016-05-01") } });
      const kept = await held();
      await rejudgeTitles({ tripId: trip.id });
      expect(await db.photo.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ annotationMembersOnly: true, annotationTitleOnly: false });
    });
  });
});
