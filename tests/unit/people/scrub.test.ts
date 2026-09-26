import { describe, expect, it } from "vitest";
import { nameMatcher, scrubAnnotation, annotationMentions } from "@/lib/people/scrub";
import type { StoredAnnotation } from "@/lib/annotation/schema";

const scrub = (names: string | string[], text: string, others: string[] = [], tagged = false, there: string[] = []) => nameMatcher(Array.isArray(names) ? names : [names], others).scrub(text, { tagged, others: there });

describe("taking a forgotten full name out of text", () => {
  it("replaces only the whole name, never letters inside another word", () => {
    expect(scrub("Ed Jones", "Kids in the bedroom with Ed Jones")).toBe("Kids in the bedroom with a family member");
    expect(scrub("Ann Smith", "The annual trip to Annapolis with ann smith")).toBe("The annual trip to Annapolis with a family member");
  });

  it("keeps possessives, either apostrophe, periods that are there or not, and hyphen or space", () => {
    expect(scrub("Pat O'Neil", "Pat O’Neil’s boat, and Pat O'Neil's hat")).toBe("A family member’s boat, and a family member's hat");
    expect(scrub("J.R. Smith", "JR Smith and J.R. Smith")).toBe("A family member and a family member");
    expect(scrub("Ann-Marie Lee", "Ann Marie Lee waves")).toBe("A family member waves");
    expect(scrub("Ann Marie Lee", "Ann-Marie Lee waves")).toBe("A family member waves");
  });

  it("drops a title or kinship word before the name", () => {
    expect(scrub("Dr. Ed Jones", "Ed Jones at the clinic, then Dr Ed Jones")).toBe("A family member at the clinic, then a family member");
    // "Grandma Ruth" is Ruth, and that is safe to look for anywhere.
    expect(scrub("Grandma Ruth", "Ruth baked; Grandma Ruth smiled")).toBe("A family member baked; a family member smiled");
    expect(nameMatcher(["Grandma Ruth"]).albumForms).toContain("Ruth");
    // A hyphenated first name stays together.
    expect(scrub("Ann-Marie Lee", "Ann-Marie waved; Ann went home", [], true)).toBe("A family member waved; Ann went home");
  });

  it("treats accented, unaccented, decomposed and non-Latin spellings as the name", () => {
    expect(scrub("José Ruiz", "José Ruiz and Jose Ruiz and José Ruiz")).toBe("A family member and a family member and a family member");
    expect(scrub("Лена Иванова", "Лена Иванова и Леночка")).toBe("A family member и Леночка");
    expect(scrub("Ana Lopez", "Anaïs Lopez waves; Anaïs Lopez too")).toBe("Anaïs Lopez waves; Anaïs Lopez too");
    // Somebody else's name is compared without accents: Zoe Smith makes "Zoë" ambiguous away from her photographs.
    expect(scrub("Zoë Byron", "Zoë waves", ["Zoe Smith"])).toBe("Zoë waves");
  });

  it("matches after an elision, but not inside an Irish surname", () => {
    expect(scrub("Ann Smith", "le chat d'Ann Smith; O'Ann Smith")).toBe("le chat d'a family member; O'Ann Smith");
  });

  it("finds names in scripts written without spaces, and keeps the ones that are also words to her own photographs", () => {
    expect(scrub("山田花子", "山田 花子さんと公園で")).toBe("A family memberさんと公園で");
    expect(scrub("花子", "花子と山田花子", ["山田花子"], true)).toBe("A family memberと山田花子");
    expect(scrub("さくら", "さくらが咲いた")).toBe("さくらが咲いた");
    expect(scrub("さくら", "さくらが咲いた", [], true)).toBe("A family memberが咲いた");
    expect(scrub("春花", "春花の写真")).toBe("春花の写真");
    expect(nameMatcher(["山田花子"]).albumForms).toContain("山田花子");
    expect(nameMatcher(["さくら"]).albumForms).toEqual([]);
  });

  it("matches a full name made only of everyday words only as a name is written", () => {
    expect(scrub("Holly Berry", "holly berry pie; Holly Berry waved")).toBe("holly berry pie; a family member waved");
  });

  it("takes out every name they have gone by, and a nickname in the name", () => {
    expect(scrub(["Ada King", "Ada Byron"], "Ada Byron, later Ada King")).toBe("A family member, later a family member");
    expect(scrub("Ann (Nessie) Smith", "Nessie came, and so did Ann Smith")).toBe("A family member came, and so did a family member");
    expect(scrub("Ann (Nan) Smith", "Nan came")).toBe("Nan came");
  });

  it("capitalizes at the start of a sentence, after a quote or markdown, in a title-case title, and shouts only among shouting", () => {
    expect(scrub("Ada Byron", "A picnic. Ada Byron laughs.")).toBe("A picnic. A family member laughs.");
    expect(scrub("Ada Byron", '"Ada Byron waved," he said')).toBe('"A family member waved," he said');
    expect(scrub("Ada Byron", "**Ada Byron** at sea\n- Ada Byron again")).toBe("**A family member** at sea\n- A family member again");
    expect(scrub("Ada Byron", "HAPPY BIRTHDAY ADA BYRON")).toBe("HAPPY BIRTHDAY A FAMILY MEMBER");
    expect(scrub("Ada Byron", "Swimming With Ada Byron At The Lake")).toBe("Swimming With A Family Member At The Lake");
  });
});

describe("a first name on the person's own photographs", () => {
  it("is always theirs there, everyday or shared, and only where safe elsewhere", () => {
    expect(scrub("Jack Smith", "Jack laughed", [], true)).toBe("A family member laughed");
    expect(scrub("Jack Smith", "Jack laughed")).toBe("Jack laughed");
    expect(scrub("Grace Kelly", "Grace said grace", [], true)).toBe("A family member said grace");
    expect(scrub("Mark Twain", "Mark wrote; mark the page", [], true)).toBe("A family member wrote; mark the page");
    // Another Ada exists: not on somebody else's photographs, but on hers she is Ada.
    expect(scrub("Ada Byron", "Ada waves", ["Ada Lovelace"])).toBe("Ada waves");
    expect(scrub("Ada Byron", "Ada waves", ["Ada Lovelace"], true)).toBe("A family member waves");
    expect(scrub("Ann Smith", "Ann waves", ["Ann Jones"], true)).toBe("A family member waves");
    // Unless the other one is tagged there too.
    expect(scrub("Ann Smith", "Ann waves", ["Ann Jones"], true, ["Ann Jones"])).toBe("Ann waves");
  });

  it("leaves a month in a date alone", () => {
    const may = (t: string) => scrub("May Smith", t, [], true);
    expect(may("In May we drove north. May waved.")).toBe("In May we drove north. A family member waved.");
    expect(may("May 5 at the lake; May 2019; last May")).toBe("May 5 at the lake; May 2019; last May");
    expect(scrub("May", "We may go")).toBe("We may go");
  });

  it("never takes a single letter, or a title, or a word inside another", () => {
    expect(scrub("A", "A picnic. Plan A.", [], true)).toBe("A picnic. Plan A.");
    expect(scrub("Al", "al fresco", [], true)).toBe("al fresco");
    expect(scrub(["Ada Byron", "Grandma"], "Grandma baked", [], true)).toBe("Grandma baked");
    expect(scrub('William "Bill" Jones', "paid the bill; Bill waved")).toBe("paid the bill; Bill waved");
    expect(scrub('William "Bill" Jones', "paid the bill; Bill waved", [], true)).toBe("paid the bill; a family member waved");
    expect(scrub("Jo", "Jo swims", ["Jo Smith"])).toBe("Jo swims");
    expect(scrub("Jo", "Jo swims", ["Jo Smith"], true)).toBe("A family member swims");
  });

  it("is never part of somebody else's name, except in a title-case title", () => {
    expect(scrub("Ann Smith", "Ann Jones and Mary Ann came", [], true)).toBe("Ann Jones and Mary Ann came");
    expect(scrub("Hiroshi Tanaka", "Hiroshi Swimming At The Lake")).toBe("A Family Member Swimming At The Lake");
    expect(scrub("Hiroshi Tanaka", "On Sunday Hiroshi swam with Aunt Hiroshi")).toBe("On Sunday a family member swam with Aunt a family member");
    expect(scrub("Hiroshi Tanaka", "Happy Birthday HIROSHI!")).toBe("Happy Birthday A Family Member!");
  });
});

describe("keywords", () => {
  it("on their own photographs, count every word of their name in any case, surname included", () => {
    const m = nameMatcher(["Ada Byron"]);
    const here = { tagged: true };
    expect(["ada's birthday", "grandma ada", "byron cake", "lake", "adapter"].filter((t) => !m.namesTag(t, here))).toEqual(["lake", "adapter"]);
    expect(m.scrubKeywords("ada birthday cake, byron family", here)).toBe("A family member birthday cake, a family member family");
    // Elsewhere only the whole name, or a safe name exactly.
    expect(["ada's birthday", "ada byron", "ada", "lake"].filter((t) => !m.namesTag(t))).toEqual(["ada's birthday", "lake"]);
    // Not a word somebody else tagged there shares.
    expect(m.namesTag("ada cake", { tagged: true, others: ["Ada Lovelace"] })).toBe(false);
  });

  it("drop a tag containing a safe one-word name anywhere, but never a common word elsewhere", () => {
    expect(nameMatcher(["Sam"]).namesTag("sam's bike")).toBe(true);
    const rose = nameMatcher(["Rose"]);
    expect(["rose", "rose garden"].filter((t) => !rose.namesTag(t))).toEqual(["rose", "rose garden"]);
    expect(nameMatcher(["Sam"]).albumForms).toContain("Sam");
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
