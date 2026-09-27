import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { forgetPerson } from "@/lib/people/forget-person";
import { namesSomebodyRestricted, withoutWithdrawnNames } from "@/lib/people/forget";
import { forgottenScope, loadTombstone } from "@/lib/people/tombstone";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { TABLE_3, TABLE_4, TABLE_5, TABLE_6, TABLE_7, TABLE_8 } from "./language-review-r3-rows";

/**
 * The language review's third and fourth rounds: every mention row of its table_3 (60 sentences, run alone and with a
 * family in the album), table_4 (10 aimed at the strict matcher) and table_5 (43, dashes, hyphens and dates, run alone
 * and with a family that has a Grace Kelly and a Taylor Austin) and table_6 (31, hashtags, joined dates, ordinals and
 * quotes, run the same two ways), table_7 (month and year after anything but a date word, and hashtags) and table_8
 * (month and year after "by" or "from"). On her own photograph the strict matcher decides (only a
 * month in a date's own shape is left), so each marked mention is rewritten by the forget and in a later answer; the
 * share guard refuses each for a child; a withdrawn naming publishes none of them, on her photograph or elsewhere.
 */
const record = (caption: string): StoredAnnotation => ({ title: "", caption, description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "" });

/** Her name word, as a whole word in any case: how many times it is in the text. */
const count = (word: string, text: string) => [...text.matchAll(new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, "giu"))].length;

describe("the language review's third round", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
  });

  const FAMILY_3 = ["Ben Ortiz", "Grandma Ruth", "Baby Leo"];
  const FAMILY_5 = [...FAMILY_3, "Grace Kelly", "Taylor Austin"];
  const rows = [
    ...TABLE_3.map(([name, raw]) => [name, raw, ""] as const),
    ...TABLE_3.map(([name, raw]) => [name, raw, FAMILY_3.join(", ")] as const),
    ...TABLE_4.map(([name, raw]) => [name, raw, ""] as const),
    ...TABLE_5.map(([name, raw]) => [name, raw, ""] as const),
    ...TABLE_5.map(([name, raw]) => [name, raw, FAMILY_5.join(", ")] as const),
    ...TABLE_6.map(([name, raw]) => [name, raw, ""] as const),
    ...TABLE_6.map(([name, raw]) => [name, raw, FAMILY_5.join(", ")] as const),
    ...TABLE_7.map(([name, raw]) => [name, raw, ""] as const),
    ...TABLE_7.map(([name, raw]) => [name, raw, FAMILY_5.join(", ")] as const),
    ...TABLE_8.map(([name, raw]) => [name, raw, ""] as const),
    ...TABLE_8.map(([name, raw]) => [name, raw, FAMILY_5.join(", ")] as const),
  ];

  it.each(rows)("%s: %s (the family in the album: %s)", async (name, raw, family) => {
    const text = raw.replace(/[[\]]/g, "");
    const word = raw.match(/\[([^\]]+)\]/u)?.[1] ?? name.split(" ")[0];
    // Hers are the marked ones; another may be a date ("May 2021") or somebody else ("June", "Lake Louise").
    const theirs = (raw.match(/\[/g) ?? []).length;
    const others = count(word, text) - theirs;
    // A hashtag row: no hashtag holding her name is left.
    const tagged = (t: string) => [...t.matchAll(/[#＃]\S+/gu)].some((h) => h[0].toLowerCase().includes(word.toLowerCase()));
    const left = theirs ? (t: string) => count(word, t) <= others && count(word, t) < count(word, text) && !tagged(t) : (t: string) => !tagged(t);
    const person = await db.person.create({ data: { name, birthday: new Date("2019-01-01"), createdById: admin } });
    if (family) {
      for (const n of family.split(", ")) await db.person.create({ data: { name: n, createdById: admin } });
      await db.user.create({ data: { email: "k@example.com", name: "Aunt Kay" } });
    }
    const photo = () => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation: record(text), annotatedAt: new Date() } });
    const own = await photo();
    const away = await photo();
    await db.face.create({ data: { photoId: own.id, personId: person.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    // The share guard, for a child.
    expect(await namesSomebodyRestricted([text])).toBe(true);
    // A withdrawn naming: held, or published without her.
    await db.person.update({ where: { id: person.id }, data: { namingWithdrawnAt: new Date() } });
    for (const p of [own, away]) {
      const shown = await withoutWithdrawnNames(p.id, { annotation: record(text), title: null });
      if (!shown.hold) expect(left((shown.annotation as StoredAnnotation).caption)).toBe(true);
    }
    await db.person.update({ where: { id: person.id }, data: { namingWithdrawnAt: null } });
    // The forget, on her own photograph, and a later answer there.
    await forgetPerson(person.id, { keepName: false, byUserId: admin });
    const forgotten = ((await db.photo.findUniqueOrThrow({ where: { id: own.id } })).annotation as StoredAnnotation).caption;
    const later = (await loadTombstone()).scrub(text, await forgottenScope({ photoIds: [own.id] }));
    expect({ forgotten: left(forgotten), later: left(later) }).toEqual({ forgotten: true, later: true });
  });
});
