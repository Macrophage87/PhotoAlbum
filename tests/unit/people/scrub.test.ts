import { describe, expect, it } from "vitest";
import { nameMatcher, scrubAnnotation, annotationMentions } from "@/lib/people/scrub";
import type { StoredAnnotation } from "@/lib/annotation/schema";

const scrub = (names: string | string[], text: string, others: string[] = [], tagged = false) => nameMatcher(Array.isArray(names) ? names : [names], others).scrub(text, { tagged });

describe("taking a forgotten full name out of text", () => {
  it("replaces only the whole name, never letters inside another word", () => {
    expect(scrub("Ed Jones", "Kids in the bedroom with Ed Jones")).toBe("Kids in the bedroom with a family member");
    expect(scrub("Ann Smith", "The annual trip to Annapolis with ann smith")).toBe("The annual trip to Annapolis with a family member");
  });

  it("keeps possessives, either apostrophe, periods that are there or not, and hyphen or space", () => {
    expect(scrub("Pat O'Neil", "Pat O’Neil’s boat, and Pat O'Neil's hat")).toBe("A family member’s boat, and a family member's hat");
    expect(scrub("Dr. Ed Jones", "Dr Ed Jones at the clinic")).toBe("A family member at the clinic");
    expect(scrub("J.R. Smith", "JR Smith and J.R. Smith")).toBe("A family member and a family member");
    expect(scrub("Ann-Marie Lee", "Ann Marie Lee waves")).toBe("A family member waves");
    expect(scrub("Ann Marie Lee", "Ann-Marie Lee waves")).toBe("A family member waves");
  });

  it("treats accented, unaccented, decomposed and non-Latin spellings as the name", () => {
    expect(scrub("José Ruiz", "José Ruiz and Jose Ruiz and José Ruiz")).toBe("A family member and a family member and a family member");
    expect(scrub("Лена Иванова", "Лена Иванова и Леночка")).toBe("A family member и Леночка");
    // Anaïs is not Ana, composed or not.
    expect(scrub("Ana Lopez", "Anaïs Lopez waves; Anaïs Lopez too")).toBe("Anaïs Lopez waves; Anaïs Lopez too");
  });

  it("matches after an elision, but not inside an Irish surname", () => {
    expect(scrub("Ann Smith", "le chat d'Ann Smith; O'Ann Smith")).toBe("le chat d'a family member; O'Ann Smith");
  });

  it("finds names in scripts written without spaces, but not inside somebody else's", () => {
    expect(scrub("山田花子", "山田 花子さんと公園で")).toBe("A family memberさんと公園で");
    expect(scrub("花子", "花子と山田花子", ["山田花子"])).toBe("A family memberと山田花子");
    // One character is too little to be sure of.
    expect(scrub("花", "花と公園")).toBe("花と公園");
  });

  it("takes out every name they have gone by, and a nickname in the name", () => {
    expect(scrub(["Ada King", "Ada Byron"], "Ada Byron, later Ada King")).toBe("A family member, later a family member");
    expect(scrub("Ann (Nessie) Smith", "Nessie came, and so did Ann Smith")).toBe("A family member came, and so did a family member");
    // "Nan" is what a family calls a grandmother as often as anybody's name: only on her own photographs.
    expect(scrub("Ann (Nan) Smith", "Nan came")).toBe("Nan came");
    expect(scrub("Ann (Nan) Smith", "Nan came", [], true)).toBe("A family member came");
  });

  it("capitalizes at the start of a sentence, after a quote, a bracket or markdown, and shouts only among shouting", () => {
    expect(scrub("Ada Byron", "A picnic. Ada Byron laughs.")).toBe("A picnic. A family member laughs.");
    expect(scrub("Ada Byron", '"Ada Byron waved," he said')).toBe('"A family member waved," he said');
    expect(scrub("Ada Byron", "**Ada Byron** at sea\n- Ada Byron again\n# Ada Byron")).toBe("**A family member** at sea\n- A family member again\n# A family member");
    expect(scrub("Ada Byron", "HAPPY BIRTHDAY ADA BYRON")).toBe("HAPPY BIRTHDAY A FAMILY MEMBER");
    expect(scrub("Ada Byron", "Happy birthday ADA BYRON, she wrote")).toBe("Happy birthday a family member, she wrote");
  });
});

describe("a short name", () => {
  it("is matched only as written, so everyday words stay", () => {
    expect(scrub("Ada Byron", "Ada laughs; the ada compliance")).toBe("A family member laughs; the ada compliance");
    expect(scrub("Hiroshi Tanaka", "Then Hiroshi swam")).toBe("Then a family member swam");
  });

  it("that is also an everyday word is used only on their own photographs", () => {
    // One-word names: everywhere else, nothing at all is touched.
    expect(scrub("Grace", "Grace said grace")).toBe("Grace said grace");
    expect(scrub("Grace", "Grace said grace", [], true)).toBe("A family member said grace");
    expect(scrub("May", "We may go in May", [], true)).toBe("We may go in May".replace("in May", "in a family member"));
    expect(scrub("May", "We may go in May")).toBe("We may go in May");
    expect(scrub("Bill", "paid the bill", [], true)).toBe("paid the bill");
    expect(scrub("Al", "al fresco, Plan A", [], true)).toBe("al fresco, Plan A");
    // A single letter is never a name to look for.
    expect(scrub("A", "A picnic. Plan A.", [], true)).toBe("A picnic. Plan A.");
    // A nickname and a former name are held to the same rules.
    expect(scrub('William "Bill" Jones', "paid the bill; Bill waved")).toBe("paid the bill; Bill waved");
    expect(scrub('William "Bill" Jones', "paid the bill; Bill waved", [], true)).toBe("paid the bill; a family member waved");
    expect(scrub(["Ada Byron", "Grandma"], "Grandma baked")).toBe("Grandma baked");
  });

  it("shared with somebody else the album knows is only theirs on their own photographs", () => {
    expect(scrub("Jo", "Jo swims", ["Jo Smith"])).toBe("Jo swims");
    expect(scrub("Jo", "Jo swims", ["Jo Smith"], true)).toBe("A family member swims");
    expect(scrub("Ada Byron", "Ada waves with Ada Byron", ["Ada Lovelace"])).toBe("Ada waves with a family member");
  });

  it("is never part of somebody else's name, except in a title-case title", () => {
    expect(scrub("Ann Smith", "Ann Jones and Mary Ann came")).toBe("Ann Jones and Mary Ann came");
    expect(scrub("Hiroshi Tanaka", "Mary Hiroshi swam. Then Hiroshi ate.")).toBe("Mary Hiroshi swam. Then a family member ate.");
    expect(scrub("Hiroshi Tanaka", "Hiroshi Swimming At The Lake")).toBe("A family member Swimming At The Lake");
    expect(scrub("Hiroshi Tanaka", "On Sunday Hiroshi swam with Aunt Hiroshi")).toBe("On Sunday a family member swam with Aunt a family member");
    expect(scrub("Hiroshi Tanaka", "Happy Birthday HIROSHI!")).toBe("Happy Birthday a family member!");
  });

  it("is dropped from tags only as the whole tag, never inside another", () => {
    const m = nameMatcher(["Ada Byron"]);
    expect(["ada", "ada's cake", "ada compliance", "ada byron", "lake"].filter((t) => !m.namesTag(t))).toEqual(["ada's cake", "ada compliance", "lake"]);
    const rose = nameMatcher(["Rose"]);
    expect(["rose", "rose garden"].filter((t) => !rose.namesTag(t))).toEqual(["rose", "rose garden"]);
    expect(["rose", "rose garden"].filter((t) => !rose.namesTag(t, { tagged: true }))).toEqual(["rose garden"]);
  });
});

describe("the helper's record", () => {
  const record: StoredAnnotation = {
    title: "Ada Byron at the lake",
    caption: "Ada Byron wading in",
    description: "Ada Byron and Ben at the lake. Ada's dog swims.",
    tags: ["ada byron", "lake", "adapter"],
    place: "Ada Byron's cabin",
    activity: "swimming",
    objects: ["ada byron's hat", "boat"],
    visibleText: "ADA BYRON",
    season: "summer",
    mood: "happy",
    searchSummary: "ada byron lake swim",
  };

  it("has every prose field rewritten, the title included", () => {
    const m = nameMatcher(["Ada Byron"]);
    const out = scrubAnnotation(record, m);
    expect(annotationMentions(out, m)).toBe(false);
    expect(out).toMatchObject({ title: "A family member at the lake", description: "A family member and Ben at the lake. A family member's dog swims.", tags: ["lake", "adapter"], objects: ["boat"], visibleText: "A FAMILY MEMBER", season: "summer" });
  });

  it("comes back well-formed from a malformed record, rather than throwing", () => {
    const bad = { title: 5, caption: null, tags: "ada", objects: [3, "ada byron", "boat"], description: "Ada Byron swims" } as unknown as StoredAnnotation;
    const out = scrubAnnotation(bad, nameMatcher(["Ada Byron"]));
    expect(out).toMatchObject({ title: "", caption: "", tags: [], objects: ["boat"], description: "A family member swims" });
    expect(nameMatcher([null as unknown as string]).scrub("anything")).toBe("anything");
    expect(nameMatcher(["Ada Byron"]).scrub(42)).toBe(42);
  });
});
