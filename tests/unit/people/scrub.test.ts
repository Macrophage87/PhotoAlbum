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
    // On their own photograph every match counts, in any case: over-removal there only loses a word on theirs.
    expect(scrub("Grace Kelly", "Grace said grace", [], true)).toBe("A family member said a family member");
    expect(scrub("Mark Twain", "Mark wrote; mark the page", [], true)).toBe("A family member wrote; a family member the page");
    // Another Ada exists: not on somebody else's photographs, but on hers she is Ada.
    expect(scrub("Ada Byron", "Ada waves", ["Ada Lovelace"])).toBe("Ada waves");
    expect(scrub("Ada Byron", "Ada waves", ["Ada Lovelace"], true)).toBe("A family member waves");
    expect(scrub("Ann Smith", "Ann waves", ["Ann Jones"], true)).toBe("A family member waves");
    // Unless the other one is tagged there too.
    expect(scrub("Ann Smith", "Ann waves", ["Ann Jones"], true, ["Ann Jones"])).toBe("Ann waves");
  });

  it("leaves a month in a date alone", () => {
    const may = (t: string) => scrub("May Smith", t, [], true);
    // Only in a date's own shape: a year, a day and a year, an ordinal day at the end (strict-names.ts).
    expect(may("In May we drove north. May waved.")).toBe("In a family member we drove north. A family member waved.");
    expect(may("May 2019; May 5, 2019; back in May 2020; the 5th of May.")).toBe("May 2019; May 5, 2019; back in May 2020; the 5th of May.");
    expect(may("Back in May. May 5 at the beach. Up next May!")).toBe("Back in a family member. A family member 5 at the beach. Up next a family member!");
    expect(may("May 5 at the lake; last May")).toBe("A family member 5 at the lake; last a family member");
    expect(scrub("May", "We may go")).toBe("We may go");
  });

  it("never takes a single letter, or a title, or a word inside another", () => {
    expect(scrub("A", "A picnic. Plan A.", [], true)).toBe("A picnic. Plan A.");
    expect(scrub("Al", "al fresco", [], true)).toBe("al fresco");
    expect(scrub(["Ada Byron", "Grandma"], "Grandma baked", [], true)).toBe("Grandma baked");
    expect(scrub('William "Bill" Jones', "paid the bill; Bill waved")).toBe("paid the bill; Bill waved");
    expect(scrub('William "Bill" Jones', "paid the bill; Bill waved", [], true)).toBe("paid a family member; a family member waved");
    expect(scrub("Jo", "Jo swims", ["Jo Smith"])).toBe("Jo swims");
    expect(scrub("Jo", "Jo swims", ["Jo Smith"], true)).toBe("A family member swims");
  });

  it("is never part of somebody else's name, except in a title-case title", () => {
    // (On her own photograph every match of hers counts, inside somebody else's name too.)
    expect(scrub("Ann Smith", "Ann Jones and Mary Ann came", [], true)).toBe("A family member Jones and Mary a family member came");
    expect(scrub("Ann Smith", "Ann Jones and Mary Ann came")).toBe("Ann Jones and Mary Ann came");
    expect(scrub("Hiroshi Tanaka", "Hiroshi Swimming At The Lake")).toBe("A Family Member Swimming At The Lake");
    expect(scrub("Hiroshi Tanaka", "On Sunday Hiroshi swam with Aunt Hiroshi")).toBe("On Sunday a family member swam with Aunt a family member");
    expect(scrub("Hiroshi Tanaka", "Happy Birthday HIROSHI!")).toBe("Happy Birthday A Family Member!");
  });
});

describe("keywords", () => {
  it("on their own photographs, count every word of their name in any case, surname included", () => {
    const m = nameMatcher(["Ada Byron"]);
    const here = { tagged: true };
    // Every word of her name that could be hers alone, in any case: "byron bay" loses "byron" on her own photograph.
    expect(["ada's birthday", "grandma ada", "byron", "byron ada", "byron bay", "byron cake", "lake", "adapter"].filter((t) => !m.namesTag(t, here))).toEqual(["lake", "adapter"]);
    expect(m.scrubKeywords("ada birthday cake, byron bay, byron ada", here)).toBe("A family member birthday cake, a family member bay, a family member");
    // Elsewhere only the whole name, or a safe name exactly.
    expect(["ada's birthday", "ada byron", "ada", "lake"].filter((t) => !m.namesTag(t))).toEqual(["ada's birthday", "lake"]);
    // Not a word somebody else tagged there shares.
    expect(m.namesTag("ada cake", { tagged: true, others: ["Ada Lovelace"] })).toBe(false);
  });

  it("leave everyday words, months and surnames alone unless they are plainly the name", () => {
    const here = { tagged: true };
    const grace = nameMatcher(["Grace Hopper"]);
    // On her own photograph, strictly: every "grace" and "may"; an everyday surname alone ("wood") is not hers.
    expect(["saying grace", "grace", "grace's hat", "grace hopper", "lake"].filter((t) => !grace.namesTag(t, here))).toEqual(["lake"]);
    const may = nameMatcher(["May Wood"]);
    expect(["may blossoms", "wood fire", "may", "may's", "wood may", "may 2019", "lake"].filter((t) => !may.namesTag(t, here))).toEqual(["wood fire", "may 2019", "lake"]);
    expect(may.scrubKeywords("may blossoms, wood fire, may wood picnic", here)).toBe("A family member blossoms, wood fire, a family member picnic");
    // Elsewhere, as before.
    expect(["saying grace", "grace's hat"].filter((t) => !grace.namesTag(t))).toEqual(["saying grace", "grace's hat"]);
  });

  it("take their surname alone out of a search summary on a photograph about them, but not a place's", () => {
    const ruth = nameMatcher(["Ruth Jones"]);
    const here = { tagged: true };
    expect(ruth.scrubKeywords("jones family reunion", here)).toBe("A family member family reunion");
    expect(ruth.scrubKeywords("picnic, jones family", { tagged: true, onPhoto: false })).toBe("picnic, a family member family");
    // On her own photograph strictly, a place's word beside it or not.
    for (const t of ["jones beach picnic", "picnic at jones park", "jones 2019"]) expect(ruth.scrubKeywords(t, here)).toBe(t.replace("jones", "A family member").replace(/^picnic at A/, "picnic at a"));
    // On a photograph the record's words say is about her (not hers), a place's word keeps it.
    for (const t of ["jones beach picnic", "picnic at jones park", "jones 2019"]) expect(ruth.scrubKeywords(t, { tagged: true, onPhoto: false })).toBe(t);
    // A bag of words: the word before says nothing.
    expect(ruth.scrubKeywords("barbara pier jones family", here)).toBe("barbara pier a family member family");
    expect(ruth.scrubKeywords("florence jones", here)).toBe("florence a family member");
    // Not off their photographs, nor where somebody tagged there shares it, nor an everyday surname ("wood fire").
    expect(ruth.scrubKeywords("jones family reunion")).toBe("jones family reunion");
    expect(ruth.scrubKeywords("jones family reunion", { tagged: true, others: ["Ben Jones"] })).toBe("jones family reunion");
    expect(nameMatcher(["Ada Wood"]).scrubKeywords("wood fire", here)).toBe("wood fire");
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
    // Strictly on her own photograph: the place goes too. Away from it, the place stays.
    expect(m.scrub("A trip to Florence, Italy; Florence, Italy.", { tagged: true })).toBe("A trip to a family member, Italy; a family member, Italy.");
    expect(m.scrub("A trip to Florence, Italy; Florence, Italy.", { away: true })).toBe("A trip to Florence, Italy; Florence, Italy.");
    expect(m.scrub("A walk to Florence's house with Florence", { tagged: true })).toBe("A walk to a family member's house with a family member");
    const may = nameMatcher(["May Jones"]);
    // "May Day" is a day's name; a maypole is not.
    expect(may.scrub("May Day at the fair. The May pole. MAY DAY", { tagged: true })).toBe("May Day at the fair. A family member pole. MAY DAY");
    expect(may.scrub("Back in May 2019. May 2019. The 5th of May.", { tagged: true })).toBe("Back in May 2019. May 2019. The 5th of May.");
    expect(may.scrub("May swims", { tagged: true })).toBe("A family member swims");
  });
});

describe("words around a first name", () => {
  it("make it a place only if it is one the album knows", () => {
    const m = nameMatcher(["Ximena Ortiz"]);
    expect(m.scrub("Grandpa waving to Ximena at the lake; a gift from Ximena; smiling at Ximena; near Ximena")).toBe("Grandpa waving to a family member at the lake; a gift from a family member; smiling at a family member; near a family member");
    expect(m.scrub("Ximena, Italy", { tagged: true })).toBe("A family member, Italy");
    const f = nameMatcher(["Florence Adams"]);
    expect(f.scrub("Florence, Italy in spring.", { tagged: true })).toBe("A family member, Italy in spring.");
    expect(f.scrub("Florence, Italy in spring.", { away: true })).toBe("Florence, Italy in spring.");
    // Not a place and its region when the word after the comma is somebody's name.
    expect(nameMatcher(["Florence Adams"], ["Ben Ortiz"]).scrub("Left to right: Florence, Ben.", { tagged: true })).toBe("Left to right: a family member, Ben.");
    // A first name taken from a full one is the listed place after "to" even on their photographs.
    expect(f.scrub("We flew to Florence. Florence waved; a gift from Florence", { tagged: true })).toBe("We flew to a family member. A family member waved; a gift from a family member");
    // For somebody merely not to be named, a first name alone away from their photographs is left.
    expect(f.scrub("Train to Florence; Florence waved", { fullOnly: true })).toBe("Train to Florence; Florence waved");
  });

  it("at the start of a sentence, are a place on their own photographs only where one is plainly meant", () => {
    const f = nameMatcher(["Florence"]);
    const c = nameMatcher(["Charlotte"]);
    expect(f.scrub("Florence at the lake", { tagged: true })).toBe("A family member at the lake");
    expect(c.scrub("Charlotte at the beach", { tagged: true })).toBe("A family member at the beach");
    expect(f.scrub("Florence and Ben swam.", { tagged: true })).toBe("A family member and Ben swam.");
    expect(f.scrub("Florence in the garden", { tagged: true })).toBe("A family member in the garden");
    for (const t of ["Florence, Italy", "Florence trip", "Florence 2019"]) expect(f.scrub(t, { tagged: true })).toBe(t.replace("Florence", "A family member"));
    // Alone as a title, or ending one, on her photograph it is her.
    expect(f.scrub("Trip: Florence", { tagged: true })).toBe("Trip: a family member");
    expect(c.scrub("Charlotte", { tagged: true })).toBe("A family member");
    // Away from them, the wider guard.
    for (const t of ["Florence at the lake", "Florence and Tuscany 2019", "Florence in spring", "Florence, Italy", "Trip: Florence"]) expect(f.scrub(t)).toBe(t);
  });

  it("keep a region after its city away from their photographs", () => {
    const g = nameMatcher(["Georgia Brown"]);
    for (const t of ["Atlanta, Georgia", "We drove to Savannah, Georgia at dawn"]) expect(g.scrub(t)).toBe(t);
    // In their trip but not on this photograph, a place-like name is the place unless plainly them.
    const c = nameMatcher(["Charlotte Smith"]);
    expect(c.scrub("Charlotte in the rain", { tagged: true, onPhoto: false })).toBe("Charlotte in the rain");
    expect(c.scrub("Charlotte in the rain", { tagged: true })).toBe("A family member in the rain");
  });

  it("keep a region after a listed city everywhere, on their own photographs too", () => {
    const g = nameMatcher(["Georgia Brown"]);
    expect(g.scrub("We drove from Atlanta, Georgia.", { tagged: true })).toBe("We drove from Atlanta, a family member.");
    expect(g.scrub("We drove from Atlanta, Georgia.", { away: true })).toBe("We drove from Atlanta, Georgia.");
    expect(g.scrub("Georgia and Ben swam.", { tagged: true })).toBe("A family member and Ben swam.");
    // Not after a name: "Ada" is no city.
    expect(g.scrub("Left to right: Ada, Georgia.")).toBe("Left to right: Ada, a family member.");
  });

  it("judge title case sentence by sentence", () => {
    expect(nameMatcher(["Georgia Brown"]).scrub("Atlanta, Georgia. Then Savannah, Georgia. Georgia waved.")).toBe("Atlanta, Georgia. Then Savannah, Georgia. A family member waved.");
  });

  it("take a kinship word with the name on their own photograph, as the forgotten names do", () => {
    expect(nameMatcher(["Sam Kent"]).scrub("Grandpa Sam at the lake", { tagged: true })).toBe("A family member at the lake");
    // On his own photograph "Uncle Sam" is him; elsewhere the saying.
    expect(nameMatcher(["Sam Kent"]).scrub("Uncle Sam hugged the kids.", { tagged: true })).toBe("A family member hugged the kids.");
    expect(nameMatcher(["Sam Kent"]).scrub("Uncle Sam hat on Ben")).toBe("Uncle Sam hat on Ben");
    expect(nameMatcher(["Grandma Ruth"]).scrub("Nana Ruth bakes", { tagged: true })).toBe("A family member bakes");
    expect(nameMatcher(["Grace Kelly"]).scrub("Singing Amazing Grace with Grace Kelly")).toBe("Singing Amazing Grace with a family member");
    // On their own photograph every match is theirs, the verbs and sayings too (strict-names.ts).
    expect(nameMatcher(["Grandma Ruth"]).scrub("Aunt Ruth waves", { tagged: true })).toBe("A family member waves");
    expect(nameMatcher(["Will Turner"]).scrub("Will you look at that!", { tagged: true })).toBe("A family member you look at that!");
    // Away from their photographs, a name that is also a verb used as one stays: before a pronoun, and "May the
    // fourth".
    for (const [name, text] of [["Will Turner", "Will we ever see snow? Will it rain?"], ["May Lee", "May you have many more. May the fourth be with you!"], ["Hope Kent", "Hope you like it!"]]) expect([name, nameMatcher([name]).scrub(text, { away: true })]).toEqual([name, text]);
    for (const [name, text, want] of [
      ["Will Turner", "Will we ever see snow? Will it rain?", "A family member we ever see snow? A family member it rain?"],
      ["May Lee", "May you have many more. May the fourth be with you!", "A family member you have many more. A family member the fourth be with you!"],
      ["Hope Kent", "Hope you like it!", "A family member you like it!"],
      // Before anything but a pronoun it is them: "Will the ring bearer", "Hope my little helper".
      ["Will Turner", "Will the ring bearer walking down the aisle.", "A family member the ring bearer walking down the aisle."],
      ["Hope Kent", "Hope my little helper in the kitchen.", "A family member my little helper in the kitchen."],
      ["May Lee", "May this morning at the park.", "A family member this morning at the park."],
      // "be", "not", "all" and "so" say nothing: it is as often them.
      ["Will Turner", "Will not impressed by the snow.", "A family member not impressed by the snow."],
      ["May Lee", "May all smiles at her party.", "A family member all smiles at her party."],
      ["Hope Kent", "Hope so proud of her medal.", "A family member so proud of her medal."],
      ["Hope Kent", "Hope to the rescue!", "A family member to the rescue!"],
      ["Will Turner", "Will swam faster than Ben.", "A family member swam faster than Ben."],
      ["Will Turner", "Will and Ben at the lake.", "A family member and Ben at the lake."],
      ["Hope Kent", "Hope hugs the dog.", "A family member hugs the dog."],
      ["May Lee", "May waves at the camera.", "A family member waves at the camera."],
    ]) expect([name, nameMatcher([name]).scrub(text, { tagged: true })]).toEqual([name, want]);
    expect(nameMatcher(["Jack Brown"]).scrub("Jack in the box", { tagged: true })).toBe("A family member in the box");
    expect(nameMatcher(["Jack Brown"]).scrub("Jack in the box", { away: true })).toBe("Jack in the box");
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
    expect(scrub("Jack Byron", "The Union Jack. Jack swam.", [], true)).toBe("The Union a family member. A family member swam.");
    // Away from their photographs the language rules decide, as before.
    expect(nameMatcher(["Jack Byron"]).scrub("The Union Jack. Jack swam.", { away: true })).toBe("The Union Jack. Jack swam.");
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

  it("reads 'by May's side', 'by May', 'by May 5' and 'in May' as her on her own photograph, and 'May 5, 2019' as a date", () => {
    // After "by", "on", "of" or "from" a month is her unless a day or a year follows: over-removal there is the lesser
    // evil ("A card from May", "Waiting on June").
    expect(scrub("May Smith", "By May's side all day; done by May", [], true)).toBe("By a family member's side all day; done by a family member");
    // On her own photograph "by May 5" and "in May." are not dates (a day counts only with a year; strict-names.ts).
    expect(scrub("May Smith", "Done by May 5, back in May.", [], true)).toBe("Done by a family member 5, back in a family member.");
    expect(scrub("May Smith", "Done by May 5, 2019, back in May 2020.", [], true)).toBe("Done by May 5, 2019, back in May 2020.");
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
