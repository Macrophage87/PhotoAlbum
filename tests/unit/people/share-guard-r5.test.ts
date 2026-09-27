import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetTestDb } from "../helpers/reset";

vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => {} }));

import { namesSomebodyRestricted } from "@/lib/people/restricted";
import { withoutWithdrawnNames } from "@/lib/people/forget";
import { strictMatcher } from "@/lib/people/strict-names";
import { nameMatcher } from "@/lib/people/scrub";
import { judgeHelperText } from "@/lib/annotation/members-only";
import type { StoredAnnotation } from "@/lib/annotation/schema";

/**
 * Round five on 5d14285: dashes and hyphens (the share-guard attacker's blocking regression and the language review's
 * B1/B2), the full-name excuse only in one field, with capitals, and never in keywords, and the month rule's shapes
 * (the language review's B3).
 */
const PLACE_NAMED = ["Madison", "Jordan", "Paris", "Austin", "Brooklyn", "Florence", "Geneva", "Louise", "Sierra", "Charlotte", "Georgia", "Savannah", "Victoria"];

/** [her name, the words, or a list: [prose, keywords]] */
const REFUSED: [string, string][] = [
  ...PLACE_NAMED.map((n) => [`${n} Clark`, `Sunny day—${n} builds a sandcastle`] as [string, string]),
  ["Madison Clark", "Madison—all smiles—at the park"],
  ["Madison Clark", "Sunny day–Madison builds a sandcastle"],
  ["Madison Clark", "Madison-approved snacks"],
  ["Madison Clark", "a Madison-sized cake"],
  ["Madison Clark", "Team-Madison"],
  ["Madison Clark", "Ben-and-Madison lemonade stand"],
  ["Madison Clark", "Pre-Madison"],
  ["Madison Clark", "Madison-Rose at the park"],
  ["Madison Clark", "Madison‑Grace"],
  ["Madison Clark", "Madison‐led"],
  ["Madison Clark", "Madison-Lee Smith"],
  ["June Carter", "June-bug in her Halloween costume."],
  ["Grace Hopper", "Super-Grace to the rescue!"],
  ["May Chen", "Mini-May and her big brother."],
  // Months: only a date's own shapes are dates.
  ["May Chen", "Leo 7, May 5."],
  ["June Carter", "Ages this summer: Ben 9, Leo 7, June 4."],
  ["May Chen", "Tucking in May."],
  ["June Carter", "Grandpa tucks in June."],
  ["April Reyes", "Time to tuck in April."],
  ["August Lind", "Let's bring in August."],
  ["June Carter", "Up next June!"],
  ["May Chen", "A swim in May."],
  ["June Carter", "Late June at the lake"],
  ["May Chen", "May 5 at the beach"],
  ["May Chen", "May 2020 swims across the lake"],
  ["June Carter", "She is in June."],
  ["June Carter", "Snuggled up in June."],
  ["May Chen", "Happy birthday May 5!"],
  ["May Chen", "Ben 5 May 3."],
  ["August Lind", "Hot August day—August in the sprinkler."],
];

const SHARED: [string, string][] = [
  ["May Chen", "May 2019 at the cabin."],
  ["May Chen", "May 5, 2019."],
  ["May Chen", "May 5th, 2019."],
  ["May Chen", "Picnic on May 5th."],
  ["May Chen", "The 5th of May."],
  ["June Carter", "Late June, 2019."],
  ["June Carter", "Early June 2019 at the lake."],
  ["May Chen", "May Day at the fair."],
];

describe("the share guard, round five", () => {
  let admin: string;
  beforeEach(async () => {
    await resetTestDb();
    admin = (await db.user.create({ data: { email: "admin@example.com", role: "ADMIN" } })).id;
  });
  const child = (name: string) => db.person.create({ data: { name, birthday: new Date("2016-05-01"), createdById: admin } });
  const adult = (name: string) => db.person.create({ data: { name, birthday: new Date("1980-05-01"), createdById: admin } });

  it.each(REFUSED)("refuses %s: %s, and takes her out of it on her own photograph", async (name, text) => {
    await child(name);
    expect(await namesSomebodyRestricted([text])).toBe(true);
    const first = name.split(" ")[0];
    const left = nameMatcher([name]).scrub(text, { tagged: true });
    // Every whole word of hers goes, but for a month in a date's own shape (none of these rows has one of hers).
    expect([text, strictMatcher([name])(left)]).toEqual([text, false]);
    expect(left).not.toMatch(new RegExp(`(?<![\\p{L}])${first}(?![\\p{L}])(?!-\\p{L})`, "u"));
  });

  it.each(SHARED)("shares %s: %s", async (name, text) => {
    await child(name);
    expect(await namesSomebodyRestricted([text])).toBe(false);
  });

  it("skips a hyphenated word only when the whole of it is somebody else's name the album knows", async () => {
    await child("Ann Lee");
    expect(await namesSomebodyRestricted(["Ann-Marie at the park"])).toBe(true);
    await adult("Ann-Marie Smith");
    expect(await namesSomebodyRestricted(["Ann-Marie at the park"])).toBe(false);
    expect(await namesSomebodyRestricted(["Ann-Maria at the park", "Pre-Ann"])).toBe(true);
  });

  describe("somebody else's full name excuses a match only in one field, with capitals, and never in keywords", () => {
    beforeEach(async () => {
      await child("Jordan Price");
      await child("Grace Hopper");
      await adult("Tom Jordan");
      await adult("Grace Kelly");
    });

    it("in prose, written in full", async () => {
      expect(await namesSomebodyRestricted(["Picnic with Tom Jordan."])).toBe(false);
      expect(await namesSomebodyRestricted(["Grandma and Grace Kelly at the recital."])).toBe(false);
    });

    it("not across a line, a hyphen or two spaces, nor in lower case", async () => {
      for (const t of ["Picnic with Tom\nJordan on the swing", "Picnic with Tom-Jordan", "Picnic with Tom  Jordan", "picnic with tom jordan", "Picnic with TOM jordan"]) expect([t, await namesSomebodyRestricted([t])]).toEqual([t, true]);
    });

    it("never in keywords, tags or objects", async () => {
      for (const t of ["picnic tom jordan swing park", "Picnic Tom Jordan swing", "grandma grace kelly birthday", "Grandma Grace Kelly birthday"]) expect([t, await namesSomebodyRestricted([], [t])]).toEqual([t, true]);
      const text = { title: "", caption: "A picnic", description: "", searchSummary: "Picnic Tom Jordan swing", place: null, tags: [] };
      const p = await db.photo.create({ data: { uploaderId: admin, originalName: "x.jpg", mimeType: "image/jpeg", storageKey: "k", originalPath: "k/o.jpg", sizeBytes: 1, status: "READY" } });
      expect((await judgeHelperText(p.id, text, null, false)).membersOnly).toBe(true);
      const record: StoredAnnotation = { title: "", caption: "A picnic", description: "", tags: ["Grace Kelly"], place: null, activity: null, objects: [], visibleText: null, season: "summer", mood: null, searchSummary: "", };
      expect((await withoutWithdrawnNames(p.id, { annotation: record, title: null })).hold).toBe(true);
    });
  });

  it("writes the stand-in in lower case in a sentence that is no title", () => {
    expect(nameMatcher(["Grace Hopper"], ["Grace Kelly"]).scrub("Great-grandma Grace Kelly holding Grace.", { tagged: true })).toBe("Great-grandma Grace Kelly holding a family member.");
    expect(nameMatcher(["Ada Byron"]).scrub("Ada At The Lake", { tagged: true })).toBe("A Family Member At The Lake");
  });
});
