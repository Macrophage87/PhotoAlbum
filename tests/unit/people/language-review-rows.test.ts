import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { forgetPerson } from "@/lib/people/forget-person";
import { namesSomebodyRestricted, withoutWithdrawnNames } from "@/lib/people/forget";
import { forgottenScope, loadTombstone } from "@/lib/people/tombstone";
import type { StoredAnnotation } from "@/lib/annotation/schema";

/**
 * The language review's second table (94 sentences about children whose names are also months, words or places).
 * [..] marks a mention of her; "?" rows are ambiguous and not checked. For every mention: the share guard refuses it
 * (a child), a withdrawal in its fortnight never publishes it (on her photograph or another), and her own photograph
 * loses it when she is forgotten and in a later answer. Words that are not her may be over-refused; that is not
 * checked here.
 */
const SUBJECTS: Record<string, string> = {
  may: "May Chen", june: "June Carter", april: "April Reyes", august: "August Lind", will: "Will Turner", hope: "Hope Adams",
  joy: "Joy Okafor", grace: "Grace Hopper", summer: "Summer Diaz", autumn: "Autumn Blake", florence: "Florence Adams",
  paris: "Paris Moreau", austin: "Austin Blake", madison: "Madison Clark", jordan: "Jordan Price", brooklyn: "Brooklyn Shaw",
  geneva: "Geneva Holt", louise: "Louise Dunmore", sierra: "Sierra Okafor",
};
const ROWS: Record<string, string[]> = {
  may: [
    "Goodnight, [May].",
    "Goodnight [May].",
    "Happy 5th birthday [May]!",
    "Look at [May] go!",
    "[May] can swim now!",
    "[May] is five today.",
    "[May] in her new party dress.",
    "[May], 7, and Ben, 5, at the lake.",
    "[May] the birthday girl, blowing out candles.",
    "Waiting on [May] to finish her nap.",
    "A card from [May] for Grandpa.",
    "Early May picnic at the park.",
    "[May] with Grandma at the fair.",
    "So proud of [May] today.",
  ],
  june: [
    "[June] on the swings.",
    "[June] under the big oak tree.",
    "Love you, [June]!",
    "Bath time for [June].",
    "Ben chasing [June] across the yard.",
    "June weekend at the cabin.",
    "[June] was so excited for the fair.",
    "Too tired for words: [June] after the party.",
    "[JUNE] ON THE SWINGS",
    "Ben and the twins waited on [June] for an hour.",
  ],
  april: [
    "[April], 4, on her first bike.",
    "[April] can't stop giggling.",
    "Snuggles with [April] this morning.",
    "Nap time for [April].",
    "April showers at the zoo.",
    "Everyone cheering for [April] at the recital.",
  ],
  august: [
    "[August], 3, at the beach.",
    "A kiss from [August].",
    "[August] in the pool with Dad.",
    "Late August sunset over the lake.",
    "Everyone waiting for [August] to blow out the candles.",
  ],
  will: [
    "[Will] the ring bearer walking down the aisle.",
    "Ben and [Will] the budding fisherman.",
    "A hug from [Will] after the game.",
    "Will we ever get a family photo where everyone smiles?",
    "[Will], 6, and his new bike.",
  ],
  hope: [
    "[Hope] the flower girl at Aunt Kay's wedding.",
    "A note from [Hope] to the tooth fairy.",
    "Hope you all had a great summer!",
    "Portrait of [Hope] by the window.",
    "[Hope], 9, at the spelling bee.",
  ],
  joy: [
    "Ben and [Joy] on the trampoline.",
    "A surprise visit from [Joy].",
    "Pure joy on the trampoline.",
    "Grandpa reading to [Joy] by the fire.",
    "Dad tucked in [Joy] and read her a story.",
  ],
  grace: [
    "A big hug from [Grace] after the recital.",
    "Photo of [Grace] with her grandmother.",
    "Saying grace before dinner.",
    "[Grace], 4, on the swings.",
    "Cake by [Grace], frosting by Dad.",
  ],
  summer: [
    "Waiting on [Summer] to finish her ice cream.",
    "Last summer at the lake.",
    "A drawing by [Summer], age six.",
    "Ben splashing [Summer] in the pool.",
    "?Summer at the lake with Ben.",
  ],
  autumn: [
    "Asleep in [Autumn]'s arms.",
    "Autumn leaves in the backyard.",
    "Presents from [Autumn] and Ben.",
    "The kids in [Autumn]'s class.",
  ],
  florence: [
    "Gelato with [Florence] in Florence.",
    "Dinner in Florence with [Florence] and Ben.",
    "[Florence] at the Duomo.",
    "A kiss from [Florence].",
  ],
  paris: [
    "[Paris], 5, at the Eiffel Tower.",
    "Our trip to Paris with [Paris]!",
    "[Paris] in Paris!",
    "Postcard from Paris.",
  ],
  austin: [
    "[Austin] at bat.",
    "Road trip to Austin with [Austin] and Ben.",
    "The Austin skyline at night.",
    "A high five from [Austin].",
  ],
  madison: [
    "Visiting [Madison] in the hospital.",
    "[Madison], 10, at Madison Square Garden.",
    "Flowers from [Madison] for Mom.",
  ],
  jordan: [
    "Baptism of [Jordan] at St. Mark's.",
    "[Jordan], 8, at the science fair.",
    "A drawing by [Jordan].",
  ],
  brooklyn: [
    "Walking the Brooklyn Bridge with [Brooklyn].",
    "[Brooklyn], 2, in her high chair.",
    "A kiss from [Brooklyn].",
  ],
  geneva: [
    "[Geneva] at Lake Geneva.",
    "Lake Geneva with [Geneva] at dawn.",
    "A hug from [Geneva].",
  ],
  louise: [
    "[Louise] at Lake Louise.",
    "Aunt Kay and [Louise] at the picnic.",
    "A hug from [Louise].",
  ],
  sierra: [
    "Hiking the Sierra Nevada with [Sierra].",
    "[Sierra], 2, in the Sierra foothills.",
    "A card from [Sierra].",
  ],
};


const count = (word: string, s: string) => (s.match(new RegExp(`(?<![\\p{L}\\p{N}'’])${word}(?![\\p{L}\\p{N}])`, "giu")) ?? []).length;
const record = (caption: string): StoredAnnotation => ({ title: "", caption, description: "", tags: [], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "" });

describe("the language review's second table", () => {
  const rows = Object.entries(ROWS).flatMap(([key, list]) => list.filter((raw) => !raw.startsWith("?") && raw.includes("[")).map((raw) => [SUBJECTS[key], raw] as const));
  it.each(rows)("%s: %s", async (name, raw) => {
    await resetTestDb();
    const admin = (await db.user.create({ data: { email: "a@example.com", role: "ADMIN" } })).id;
    const text = raw.replace(/[[\]]/g, "");
    const first = name.split(" ")[0];
    const outside = count(first, raw.replace(/\[[^\]]*\]/g, " "));
    const person = await db.person.create({ data: { name, birthday: new Date("2019-01-01"), createdById: admin } });
    const photo = () => db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY", annotation: record(text), annotatedAt: new Date() } });
    const own = await photo();
    const away = await photo();
    await db.face.create({ data: { photoId: own.id, personId: person.id, status: "CONFIRMED", box: [0.1, 0.1, 0.2, 0.2], confidence: 0 } });
    const refused = await namesSomebodyRestricted([text]);
    await db.person.update({ where: { id: person.id }, data: { namingWithdrawnAt: new Date() } });
    const leaks: string[] = [];
    for (const p of [own, away]) {
      const w = await withoutWithdrawnNames(p.id, { annotation: record(text), title: null });
      if (!w.hold && count(first, (w.annotation as StoredAnnotation).caption) > outside) leaks.push((w.annotation as StoredAnnotation).caption);
    }
    await db.person.update({ where: { id: person.id }, data: { namingWithdrawnAt: null } });
    await forgetPerson(person.id, { keepName: false, byUserId: admin });
    const forgotten = ((await db.photo.findUniqueOrThrow({ where: { id: own.id } })).annotation as StoredAnnotation).caption;
    const later = (await loadTombstone()).scrub(text, await forgottenScope({ photoIds: [own.id] }));
    expect({ refused, leaks, forgotten: count(first, forgotten) <= outside, later: count(first, later) <= outside }).toEqual({ refused: true, leaks: [], forgotten: true, later: true });
  });
});
