import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { namesSomebodyRestricted, withoutWithdrawnNames } from "@/lib/people/forget";
import { mentionsAnyName } from "@/lib/annotation/names";
import { strictMatcher } from "@/lib/people/strict-names";
import type { StoredAnnotation } from "@/lib/annotation/schema";

/**
 * What strangers may read, for a child and for a naming withdrawn: matched strictly (strict-names.ts). The share-guard
 * review's rows, every one refused; a month used as a date and "Lake Geneva at dawn" still shared.
 */
type Row = { name: string; text?: string; tags?: string[]; summary?: string; others?: string[]; opted?: boolean };

const REFUSED: Row[] = [
  ...["Madison", "Jordan", "Paris", "Rose", "May", "Lily"].map((n) => ({ name: n, text: `${n} the Great conquers the slide` })),
  { name: "Rose", text: "A hug from Rose" },
  { name: "May", text: "A hug from May" },
  { name: "Lily", text: "A drawing by Lily." },
  { name: "June", text: "Birthday card from June" },
  { name: "Lily", text: "Lily, 5, blows out the candles" },
  { name: "Grace", text: "Grace, 5, blows out the candles" },
  { name: "May", text: "May, 7, at the beach." },
  { name: "Rose", text: "Birthday girl ROSE TURNS 5!" },
  { name: "June", text: "Photo: JUNE WAVES" },
  { name: "Lily", text: "Cake time.\nLILY TURNS FIVE" },
  { name: "May", text: "Last May swam" },
  { name: "Rose", text: "This Rose is so happy" },
  { name: "Madison", text: "A visit to Santa. Madison whispers her wish list." },
  { name: "Jordan", text: "Meeting Santa. Jordan sat on his lap." },
  { name: "Jordan", text: "Brunch on Bleecker St. Jordan orders pancakes." },
  { name: "Madison", text: "Photo with Santa Madison smiling" },
  { name: "Zoe", text: "Zoë at the park" },
  { name: "Renee", text: "Renée at the park" },
  { name: "Chloe", text: "Chloë at the park" },
  { name: "Jose", text: "José at the park" },
  { name: "Andre", text: "André builds a sandcastle" },
  { name: "Noemi", text: "Noémi and Ben" },
  { name: "Zoe Martin", text: "Zoë Martin at the park" },
  { name: "Madison", text: "Mádison at the park" },
  { name: "Madison", text: "Cousin Madison at the lake", others: ["Cousin Eddie"] },
  { name: "Madison", text: "Baby Madison at the park", others: ["Baby Jane"] },
  { name: "Madison", text: "Little Madison at the lake", others: ["Sam Little"] },
  { name: "Madison", tags: ["madison"] },
  { name: "Madison", tags: ["madison's birthday"] },
  { name: "Madison", summary: "madison birthday party cake candles" },
  { name: "Peter", text: "Peter and Paul build a sandcastle" },
  { name: "Sam", text: "Uncle Sam hugged the kids", opted: true },
  { name: "Madison", text: "Mount Madison at the party" },
  { name: "Jordan", text: "Lake Jordan, age 5, at the beach" },
  { name: "Geneva", text: "Lake Geneva at the park with Grandma" },
  { name: "Madison", text: "Mt. Madison in her new boots" },
  { name: "Madison", text: "Ma​dison at the park" },
  { name: "Madison", text: "Madi­son at the park" },
  // The language review's round two: distinctive surnames, ages, and "the" or a possessive after a name.
  { name: "Brooklyn Shaw", text: "The Shaw kids at the lake." },
  { name: "Sierra Okafor", text: "Sierra and the Okafor twins." },
  { name: "Sierra Okafor", text: "Little Miss Okafor on her first day of school." },
  { name: "April Reyes", text: "April, 4, on her first bike." },
  { name: "Will Turner", text: "Will the ring bearer walking down the aisle." },
  { name: "Hope Adams", text: "Hope my little helper in the kitchen." },
  { name: "Grace Hopper", summary: "grace pool swimming" },
  { name: "May Chen", summary: "may chen pool" },
];

const SHARED: Row[] = [
  { name: "May", text: "Lake day in May, 2019." },
  { name: "May", text: "May 2019 at the cabin." },
  { name: "May", text: "The 5th of May." },
  { name: "Geneva", text: "Lake Geneva at dawn" },
  { name: "Geneva", text: "Lake Geneva." },
  { name: "Madison", text: "Nothing to see here." },
];

const record = (r: Row): StoredAnnotation => ({ title: "", caption: r.text ?? "", description: "", tags: r.tags ?? [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: r.summary ?? "" });
const label = (r: Row) => `${r.name}: ${JSON.stringify(r.text ?? r.tags ?? r.summary)}`;

describe("the strict share guard and a withdrawn naming", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const setUp = async (r: Row) => {
    for (const o of r.others ?? []) await db.person.create({ data: { name: o, createdById: admin } });
    return db.person.create({ data: { name: r.name, createdById: admin, ...(r.opted ? { optedOutAt: new Date() } : { birthday: new Date("2016-05-01") }) } });
  };
  const words = (r: Row) => [r.text, r.summary, ...(r.tags ?? [])];

  it.each(REFUSED.map((r) => [label(r), r] as const))("refuses %s, for a child and a withdrawn naming, tagged or not", async (_, r) => {
    const person = await setUp(r);
    expect(await namesSomebodyRestricted(words(r))).toBe(true);
    await db.person.update({ where: { id: person.id }, data: { birthday: null, optedOutAt: null, namingWithdrawnAt: new Date() } });
    const photo = () => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation: record(r) } });
    const away = await photo();
    const own = await photo();
    await db.face.create({ data: { photoId: own.id, personId: person.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    for (const p of [away, own]) {
      const shown = await withoutWithdrawnNames(p.id, { annotation: record(r), title: null });
      const a = shown.annotation as StoredAnnotation;
      const published = shown.hold ? [] : [a.caption, a.searchSummary, ...a.tags];
      expect(published.filter((w) => strictMatcher([r.name])(w))).toEqual([]);
    }
  });

  it.each(SHARED.map((r) => [label(r), r] as const))("shares %s", async (_, r) => {
    await setUp(r);
    expect(await namesSomebodyRestricted(words(r))).toBe(false);
  });

  it("keeps a refused photograph's tags and keywords out of strangers' search", async () => {
    await db.person.create({ data: { name: "Madison Clark", birthday: new Date("2016-05-01"), createdById: admin } });
    const r: Row = { name: "Madison", tags: ["madison"], summary: "madison birthday party cake candles" };
    const p = await db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation: record(r), annotationMembersOnly: true } });
    // Show to everyone is refused, so the words stay members-only, out of the public index.
    expect(await namesSomebodyRestricted(words(r))).toBe(true);
    const inPublic = async () => (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Photo" WHERE id = ${p.id} AND "searchVector" @@ plainto_tsquery('simple', 'madison')`)[0].n;
    expect(await inPublic()).toBe(0);
    // (Shown to everyone, they would be in it.)
    await db.photo.update({ where: { id: p.id }, data: { annotationMembersOnly: false } });
    expect(await inPublic()).toBe(1);
  });

  it("the members-only look sees through invisible characters and compatibility forms", () => {
    for (const t of ["Ma​dison at the park", "Madi­son at the park", "Ｍａｄｉｓｏｎ at the park"]) expect([t, mentionsAnyName(t, ["Madison Clark"])]).toEqual([t, true]);
  });
});
