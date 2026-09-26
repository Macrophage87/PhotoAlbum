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
    // A first name that is no word counts on its own; a surname only as the whole tag, or beside the first name.
    expect(["ada's birthday", "grandma ada", "byron", "byron ada", "byron bay", "byron cake", "lake", "adapter"].filter((t) => !m.namesTag(t, here))).toEqual(["byron bay", "byron cake", "lake", "adapter"]);
    expect(m.scrubKeywords("ada birthday cake, byron bay, byron ada", here)).toBe("A family member birthday cake, byron bay, a family member");
    // Elsewhere only the whole name, or a safe name exactly.
    expect(["ada's birthday", "ada byron", "ada", "lake"].filter((t) => !m.namesTag(t))).toEqual(["ada's birthday", "lake"]);
    // Not a word somebody else tagged there shares.
    expect(m.namesTag("ada cake", { tagged: true, others: ["Ada Lovelace"] })).toBe(false);
  });

  it("leave everyday words, months and surnames alone unless they are plainly the name", () => {
    const here = { tagged: true };
    const grace = nameMatcher(["Grace Hopper"]);
    expect(["saying grace", "grace", "grace's hat", "grace hopper", "lake"].filter((t) => !grace.namesTag(t, here))).toEqual(["saying grace", "grace's hat", "lake"]);
    const may = nameMatcher(["May Wood"]);
    expect(["may blossoms", "wood fire", "may", "may's", "wood may", "lake"].filter((t) => !may.namesTag(t, here))).toEqual(["may blossoms", "wood fire", "lake"]);
    expect(may.scrubKeywords("may blossoms, wood fire, may wood picnic", here)).toBe("may blossoms, wood fire, a family member picnic");
  });

  it("take a one-word name that is all of theirs out of a search summary anywhere, in any case", () => {
    expect(nameMatcher(["Ximena"]).scrubKeywords("ximena fishing at dusk")).toBe("A family member fishing at dusk");
  });

  it("drop a tag containing a safe one-word name anywhere, but never a common word elsewhere", () => {
    expect(nameMatcher(["Sam"]).namesTag("sam's bike")).toBe(true);
    const rose = nameMatcher(["Rose"]);
    expect(["rose", "rose garden"].filter((t) => !rose.namesTag(t))).toEqual(["rose", "rose garden"]);
    expect(nameMatcher(["Sam"]).albumForms).toContain("Sam");
  });
});

describe("where a first name is also a place", () => {
  it("is not taken after 'to', 'in' or 'from' away from their photographs", () => {
    expect(scrub("Florence Adams", "Train to Florence to see the Duomo; Florence Adams waved")).toBe("Train to Florence to see the Duomo; a family member waved");
    expect(scrub("Florence Adams", "With Florence at the Duomo")).toBe("With a family member at the Duomo");
  });

  it("is not taken beside a place written as one, or before a number, away from their photographs", () => {
    const m = nameMatcher(["Florence Adams"]);
    const text = "a quiet dusk. Florence, Italy. Florence 2019 was the year of the old Florence Nightingale statue by the river";
    expect(m.scrub(text)).toBe(text);
    // A first name nobody else has is taken otherwise: what is sent to the helper errs that way.
    expect(nameMatcher(["Timothy Kent"]).scrub("Timothy waved")).toBe("A family member waved");
  });

  it("on their own photographs, keeps only a place written as one", () => {
    const m = nameMatcher(["Florence Adams"]);
    expect(m.scrub("A trip to Florence, Italy; Florence, Italy.", { tagged: true })).toBe("A trip to Florence, Italy; Florence, Italy.");
    expect(m.scrub("A walk to Florence's house with Florence", { tagged: true })).toBe("A walk to a family member's house with a family member");
    const may = nameMatcher(["May Jones"]);
    expect(may.scrub("May Day at the fair. The May pole. MAY DAY", { tagged: true })).toBe("May Day at the fair. The May pole. MAY DAY");
    expect(may.scrub("May swims", { tagged: true })).toBe("A family member swims");
  });
});

describe("words around a first name", () => {
  it("make it a place only if it is one the album knows", () => {
    const m = nameMatcher(["Ximena Ortiz"]);
    expect(m.scrub("Grandpa waving to Ximena at the lake; a gift from Ximena; smiling at Ximena; near Ximena")).toBe("Grandpa waving to a family member at the lake; a gift from a family member; smiling at a family member; near a family member");
    expect(m.scrub("Ximena, Italy", { tagged: true })).toBe("A family member, Italy");
    const f = nameMatcher(["Florence Adams"]);
    expect(f.scrub("Florence, Italy in spring.", { tagged: true })).toBe("Florence, Italy in spring.");
    // Not a place and its region when the word after the comma is somebody's name.
    expect(nameMatcher(["Florence Adams"], ["Ben Ortiz"]).scrub("Left to right: Florence, Ben.", { tagged: true })).toBe("Left to right: a family member, Ben.");
    // For somebody merely not to be named, a first name alone away from their photographs is left.
    expect(f.scrub("Train to Florence; Florence waved", { fullOnly: true })).toBe("Train to Florence; Florence waved");
  });

  it("are theirs when they are words of their own name", () => {
    const m = nameMatcher(["Mary Ann Smith"]);
    expect(m.scrub("Mary Ann swam; Mary Smith dived")).toBe("A family member swam; a family member dived");
  });

  it("titles the stand-in only where the rest is title case", () => {
    expect(scrub("Ada Byron", "Trip: Ada Byron, 2019")).toBe("Trip: a family member, 2019");
  });
});

describe("a name at the start of a sentence", () => {
  it("is theirs whatever capitalized word ended the sentence before", () => {
    expect(scrub("Ada Byron", "We drove to Maine. Ada swam.")).toBe("We drove to Maine. A family member swam.");
    expect(scrub("Ada Byron", "Ben went with Tom. Ada smiled.", ["Tom Jones"])).toBe("Ben went with Tom. A family member smiled.");
    expect(scrub("Jack Byron", "The Union Jack. Jack swam.", [], true)).toBe("The Union Jack. A family member swam.");
    // An initial is no sentence end.
    expect(scrub("Ada Byron", "J. Ada Smith waved")).toBe("J. Ada Smith waved");
  });
});

describe("small words around the stand-in", () => {
  it("takes an article in front of the name with it", () => {
    expect(scrub("Ada Byron", "He met the Ada Byron everybody knew. A Ada Byron fan.")).toBe("He met a family member everybody knew. A family member fan.");
  });

  it("keeps a kinship nickname as hers on her own photographs", () => {
    expect(scrub("Ann (Nan) Smith", "Nan swam", [], true)).toBe("A family member swam");
    expect(scrub("Ann (Nan) Smith", "Nan swam")).toBe("Nan swam");
  });

  it("reads 'by May's side' as her, and 'by May' as a date", () => {
    expect(scrub("May Smith", "By May's side all day; done by May", [], true)).toBe("By a family member's side all day; done by May");
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
