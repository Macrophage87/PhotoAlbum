import { describe, expect, it } from "vitest";
import { strictMatcher } from "@/lib/people/strict-names";

/**
 * The relaxed name check's three excuses (relaxed-names.ts), each in both directions: what the relaxed check shares
 * that the strict one holds, and what it still holds. `list`: keywords, tags or objects.
 */
type Row = { name: string; text: string; list?: boolean; others?: string[] };

const SHARED: Record<"word" | "time" | "place", Row[]> = {
  // (a) An everyday word in lower case, inside a sentence, in prose.
  word: [
    { name: "Rose", text: "Grandpa planted a rose bush by the fence." },
    { name: "Grace", text: "We sat down after saying grace." },
    { name: "Hope", text: "Thanks for coming, we hope you enjoy the pictures." },
    { name: "Will", text: "The kids will be back after lunch." },
    { name: "Jack", text: "Dad changed the tire with the car jack." },
    { name: "Summer", text: "Pictures from our summer vacation." },
  ],
  // (b) A month or season used as a time.
  time: [
    { name: "May", text: "A swim in May." },
    { name: "June", text: "Late June at the lake." },
    { name: "June", text: "June sunshine on the porch." },
    { name: "Summer", text: "Summer vacation at the lake." },
    { name: "Summer", text: "Crabbing in the summer." },
    { name: "August", text: "The lake every August." },
    { name: "May", text: "May morning at the cabin." },
    { name: "Summer", text: "summer vacation", list: true },
  ],
  // (c) A listed place used as the place.
  place: [
    { name: "Brooklyn", text: "Walking the Brooklyn Bridge." },
    { name: "Florence", text: "The Duomo in Florence." },
    { name: "Austin", text: "Driving to Austin." },
    { name: "Madison", text: "Madison Square Garden at night." },
    { name: "Jordan", text: "A float down the Jordan River." },
    { name: "Paris", text: "Crepes near the Eiffel Tower, visiting Paris." },
    { name: "Florence Okafor", text: "The Duomo in Florence." },
    { name: "Florence", text: "trip to florence", list: true },
  ],
};

const HELD: Record<"word" | "time" | "place", Row[]> = {
  word: [
    // Never in keywords, tags or objects: lower case by design.
    { name: "Rose", text: "rose", list: true },
    { name: "Grace", text: "grace pool swimming", list: true },
    // Never in a hashtag.
    { name: "Rose", text: "What a day #rose" },
    { name: "Hope", text: "Loved it #hopeyouenjoy" },
    // Never before something a person does, or with "'s".
    { name: "Rose", text: "Then the baby rose smiled at us." },
    { name: "Will", text: "After lunch will swam to the dock." },
    { name: "Rose", text: "A gift for the party, rose's favorite." },
    // Never opening a sentence, never written with a capital.
    { name: "Rose", text: "rose planted the garden." },
    { name: "Rose", text: "In the garden. rose waters the plants" },
    { name: "Grace", text: "We watched Grace at the pool." },
    // Never after "with", "and", "for", "by" or "from", or before "and".
    { name: "Rose", text: "A walk with rose on the beach." },
    { name: "Hope", text: "Presents for hope on the table." },
    { name: "Rose", text: "At the beach, rose and ben built a castle." },
    // Accents, invisible characters, hyphens and plurals stay strict.
    { name: "Rose", text: "A glass of rosé on the porch." },
    { name: "Rose", text: "Grandpa planted a ro​se bush." },
    { name: "Rose", text: "A rose-colored sunset over the bay." },
    { name: "Rose", text: "A vase of roses on the table." },
  ],
  time: [
    // Never after "with", "from", "by", "for", "and".
    { name: "June", text: "Birthday card from June." },
    { name: "Summer", text: "Photos with Summer vacation plans." },
    { name: "May", text: "A drawing by May" },
    { name: "Summer", text: "Cake for Summer on the table." },
    { name: "May", text: "Ben and May day at the park." },
    // Never before something a person does, "is" or "and"; never possessive.
    { name: "May", text: "Last May swam across the pool." },
    { name: "June", text: "This June is so happy." },
    { name: "Summer", text: "In summer and Leo at the lake." },
    { name: "June", text: "June's sunshine smile." },
    { name: "June", text: "Junes vacation photos." },
    // No time word before and no time noun after.
    { name: "Summer", text: "Summer at the beach." },
    { name: "May", text: "A hug from May." },
    // A hyphen stays strict, so does an accent.
    { name: "June", text: "A mid-June picnic." },
    { name: "May", text: "A swim in Máy." },
  ],
  place: [
    // Never after "with", "and", "for" or "by".
    { name: "Paris", text: "A picnic with Paris." },
    { name: "Austin", text: "A cake for Austin." },
    { name: "Paris", text: "A drawing by Paris." },
    { name: "Austin", text: "Leo and Austin at the zoo." },
    // Never before something a person does, "'s", "at the" or "and" and a name.
    { name: "Madison", text: "Near Madison sat the old dog." },
    { name: "Austin", text: "Driving to Austin's school." },
    { name: "Madison", text: "Back in Madison at the zoo." },
    { name: "Paris", text: "We went to Paris and Leo came too." },
    // Only a capitalized place word after it; nothing else makes it a place.
    { name: "Brooklyn", text: "Walking the Brooklyn bridge." },
    { name: "Brooklyn", text: "Brooklyn on the swings." },
    // Never the child's full name, and never a name that is no listed place.
    { name: "Florence Okafor", text: "A visit to Florence Okafor." },
    { name: "Ximena", text: "Waving to Ximena." },
  ],
};

const label = (r: Row) => `${r.name}: ${JSON.stringify(r.text)}${r.list ? " (list)" : ""}`;
const strict = (r: Row) => strictMatcher([r.name], r.others ?? [])(r.text, { list: r.list });
const relaxed = (r: Row) => strictMatcher([r.name], r.others ?? [], { relaxed: true })(r.text, { list: r.list });

describe("the relaxed name check", () => {
  for (const excuse of ["word", "time", "place"] as const) {
    describe(`(${excuse})`, () => {
      it.each(SHARED[excuse].map((r) => [label(r), r] as const))("shares %s, which the strict check holds", (_, r) => {
        expect(strict(r)).toBe(true);
        expect(relaxed(r)).toBe(false);
      });
      it.each(HELD[excuse].map((r) => [label(r), r] as const))("still holds %s", (_, r) => {
        expect(strict(r)).toBe(true);
        expect(relaxed(r)).toBe(true);
      });
    });
  }

  it("excuses only the word it is about: a second mention of the name still holds the words", () => {
    expect(strictMatcher(["May"], [], { relaxed: true })("A swim in May. May swam the length of the pool.")).toBe(true);
    expect(strictMatcher(["Rose"], [], { relaxed: true })("A rose bush, and Rose beside it.")).toBe(true);
  });

  it("shares a month after \"this\" as a time, even where it is somebody: the cost Relaxed says it has", () => {
    // Refused by the strict check (share-guard-r3); a time word before a month is the excuse, as written.
    for (const t of ["Look at this May!", "Proud of this May."]) expect([t, strictMatcher(["May Chen"], [], { relaxed: true })(t)]).toEqual([t, false]);
  });

  it("keeps a month in a date's own shape and the lake rule, as the strict check does", () => {
    for (const t of ["May 2019 at the cabin.", "The 5th of May."]) expect(strictMatcher(["May"], [], { relaxed: true })(t)).toBe(false);
    expect(strictMatcher(["Geneva"], [], { relaxed: true })("Lake Geneva at dawn")).toBe(false);
  });
});
