import { describe, expect, it } from "vitest";
import { nameMatcher, safeGivenName, scrubAnnotation, annotationMentions } from "@/lib/people/scrub";
import type { StoredAnnotation } from "@/lib/annotation/schema";

const scrub = (names: string | string[], text: string, others: string[] = []) => nameMatcher(Array.isArray(names) ? names : [names], others).scrub(text);

describe("taking a forgotten full name out of text", () => {
  it("replaces only the whole name, never letters inside another word", () => {
    // Forgetting "Ed" used to leave "Kids in the ba family memberroom, ra family member sla family member".
    expect(scrub("Ed", "Kids in the bedroom, red sled")).toBe("Kids in the bedroom, red sled");
    expect(scrub("Ed", "Ed on his red sled")).toBe("A family member on his red sled");
    expect(scrub("Ann", "The annual trip to Annapolis with Ann")).toBe("The annual trip to Annapolis with a family member");
    expect(scrub("Ann", "Ann-Marie and O'Ann")).toBe("Ann-Marie and O'Ann");
  });

  it("keeps possessives, either apostrophe, and a title with or without its period", () => {
    expect(scrub("Pat O'Neil", "Pat O’Neil’s boat, and Pat O'Neil's hat")).toBe("A family member’s boat, and a family member's hat");
    expect(scrub("Dr. Ed Jones", "Dr Ed Jones at the clinic")).toBe("A family member at the clinic");
    expect(scrub("Dr Ed Jones", "Then Dr. Ed Jones spoke")).toBe("Then a family member spoke");
  });

  it("treats accented, decomposed and non-Latin names as words", () => {
    expect(scrub("José", "José and Josémaria")).toBe("A family member and Josémaria");
    expect(scrub("José", "José at the lake")).toBe("A family member at the lake");
    expect(scrub("Лена", "Лена и Леночка")).toBe("A family member и Леночка");
    // Anaïs is not Ana, composed or not.
    expect(scrub("Ana Lopez", "Anaïs waves; Anaïs too")).toBe("Anaïs waves; Anaïs too");
  });

  it("finds names in scripts written without spaces", () => {
    expect(scrub("山田花子", "山田花子さんと公園で")).toBe("A family memberさんと公園で");
    expect(scrub("김민수", "오늘 김민수의 생일")).toBe("오늘 a family member의 생일");
  });

  it("takes out every name they have gone by, and a nickname in the name", () => {
    expect(scrub(["Ada King", "Ada Byron"], "Ada Byron, later Ada King")).toBe("A family member, later a family member");
    expect(scrub("Ann (Nan) Smith", "Nan came, and so did Ann Smith")).toBe("A family member came, and so did a family member");
    expect(scrub('Robert "Bob" Jones', "Bob and the dog")).toBe("A family member and the dog");
  });

  it("capitalizes at the start of a sentence, after a quote, a bracket or markdown, and shouts only among shouting", () => {
    expect(scrub("Ada Byron", "A picnic. Ada Byron laughs.")).toBe("A picnic. A family member laughs.");
    expect(scrub("Ada Byron", '"Ada Byron waved," he said')).toBe('"A family member waved," he said');
    expect(scrub("Ada Byron", "**Ada Byron** at sea\n- Ada Byron again\n# Ada Byron")).toBe("**A family member** at sea\n- A family member again\n# A family member");
    expect(scrub("Ada Byron", "HAPPY BIRTHDAY ADA BYRON")).toBe("HAPPY BIRTHDAY A FAMILY MEMBER");
    expect(scrub("Ada Byron", "Happy birthday ADA BYRON, she wrote")).toBe("Happy birthday a family member, she wrote");
  });
});

describe("the given name on its own", () => {
  it("is only matched as written, so everyday words stay", () => {
    expect(scrub("Grace Hopper", "Grace laughs; grace before dinner")).toBe("A family member laughs; grace before dinner");
    // A month is never a name on its own.
    expect(scrub("May Smith", "We may go in May; May Smith waved")).toBe("We may go in May; a family member waved");
    expect(scrub("Will Jones", "Will will help")).toBe("A family member will help");
    expect(scrub("Rose Tyler", "a rose, the bill, an orange")).toBe("a rose, the bill, an orange");
    expect(scrub("Bill Ng", "paying the bill")).toBe("paying the bill");
  });

  it("is never somebody else's name, nor part of one", () => {
    // Forgetting Ann Smith must leave Ann Jones alone.
    expect(scrub("Ann Smith", "Ann Jones and Mary Ann came")).toBe("Ann Jones and Mary Ann came");
    // Another person the album knows answers to Grace: only the full name is hers.
    expect(scrub("Grace Hopper", "Grace laughs with Grace Hopper", ["Grace Kelly"])).toBe("Grace laughs with a family member");
    // What the family calls her still counts.
    expect(scrub("Grace Hopper", "with Aunt Grace at the lake")).toBe("with Aunt a family member at the lake");
  });

  it("is not taken from titles, everyday words or family names written first", () => {
    for (const n of ["Big Al", "The Smiths", "And Then", "Nguyễn Văn An", "Grandma Jo", "Ed Jones", "Sister Mary"]) expect(safeGivenName(n)).toBeNull();
    expect(safeGivenName("Grace Hopper")).toBe("Grace");
    expect(safeGivenName("June Carter")).toBeNull();
    expect(safeGivenName("Ada")).toBeNull();
  });

  it("is dropped from tags only as the whole tag, never inside another", () => {
    const m = nameMatcher(["Grace Hopper"]);
    expect(["grace", "grace's cake", "grace before meals", "grace hopper", "lake"].filter((t) => !m.namesTag(t))).toEqual(["grace's cake", "grace before meals", "lake"]);
    const ed = nameMatcher(["Ed"]);
    // Forgetting "Ed" used to delete "bed", "red", "sledding" and "wedding" from every photograph Ed was on.
    expect(["bed", "red", "sledding", "wedding", "ed", "ed's bike"].filter((t) => !ed.namesTag(t))).toEqual(["bed", "red", "sledding", "wedding"]);
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
    expect(out).toMatchObject({ title: "A family member at the lake", tags: ["lake", "adapter"], objects: ["boat"], visibleText: "A FAMILY MEMBER", season: "summer" });
  });

  it("comes back well-formed from a malformed record, rather than throwing", () => {
    const bad = { title: 5, caption: null, tags: "ada", objects: [3, "ada byron", "boat"], description: "Ada Byron swims" } as unknown as StoredAnnotation;
    const out = scrubAnnotation(bad, nameMatcher(["Ada Byron"]));
    expect(out).toMatchObject({ title: "", caption: "", tags: [], objects: ["boat"], description: "A family member swims" });
    expect(nameMatcher([null as unknown as string]).scrub("anything")).toBe("anything");
    expect(nameMatcher(["Ada"]).scrub(42)).toBe(42);
  });
});
