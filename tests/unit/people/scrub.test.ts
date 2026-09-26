import { describe, expect, it } from "vitest";
import { mentionsName, nameForms, scrubAnnotation, scrubName } from "@/lib/people/scrub";
import type { StoredAnnotation } from "@/lib/annotation/schema";

describe("taking a forgotten name out of text", () => {
  it("replaces only the whole word, never the letters inside another one", () => {
    // Forgetting "Ed" used to leave "Kids in the ba family memberroom, ra family member sla family member".
    expect(scrubName("Kids in the bedroom, red sled", "Ed")).toBe("Kids in the bedroom, red sled");
    expect(scrubName("Ed on his red sled", "Ed")).toBe("A family member on his red sled");
    expect(scrubName("The annual trip to Annapolis with Ann", "Ann")).toBe("The annual trip to Annapolis with a family member");
  });

  it("keeps a possessive, and leaves other people's names that merely contain it alone", () => {
    expect(scrubName("Ann's hat and Ann’s scarf", "Ann")).toBe("A family member's hat and a family member’s scarf");
    expect(scrubName("Ann-Marie and O'Ann", "Ann")).toBe("Ann-Marie and O'Ann");
  });

  it("starts a sentence with a capital, and leaves the case of the rest as it was", () => {
    expect(scrubName("A picnic. Ada laughs, and ada waves!", "Ada")).toBe("A picnic. A family member laughs, and a family member waves!");
    expect(scrubName("HAPPY BIRTHDAY ADA", "Ada")).toBe("HAPPY BIRTHDAY A FAMILY MEMBER");
  });

  it("treats accented and non-Latin names as words", () => {
    expect(scrubName("José and Josémaria", "José")).toBe("A family member and Josémaria");
    // The same name typed decomposed on another keyboard is the same name.
    expect(scrubName("José at the lake", "José")).toBe("A family member at the lake");
    expect(scrubName("Zoë's cake", "Zoë")).toBe("A family member's cake");
    expect(scrubName("Лена и Леночка", "Лена")).toBe("A family member и Леночка");
  });

  it("finds the given name as well as the whole one, but never a title on its own", () => {
    expect(nameForms("Ann Smith")).toEqual(["Ann Smith", "Ann"]);
    expect(nameForms("Grandma Jo")).toEqual(["Grandma Jo", "Jo"]);
    expect(nameForms("Great-Aunt Vi")).toEqual(["Great-Aunt Vi", "Vi"]);
    expect(scrubName("Ann Smith and her sister. Later Ann swims.", "Ann Smith")).toBe("A family member and her sister. Later a family member swims.");
    expect(scrubName("Grandma Jo with Grandma Sue", "Grandma Jo")).toBe("A family member with Grandma Sue");
  });

  it("drops the tags that name them, and only those", () => {
    const tags = ["ada", "ada's birthday", "lake", "adapter", "canada", "ADA"];
    expect(tags.filter((t) => !mentionsName(t, "Ada"))).toEqual(["lake", "adapter", "canada"]);
    // Forgetting "Ed" used to delete "bed", "red", "sledding" and "wedding" from every photograph Ed was on.
    expect(["bed", "red", "sledding", "wedding", "ed"].filter((t) => !mentionsName(t, "Ed"))).toEqual(["bed", "red", "sledding", "wedding"]);
  });

  it("rewrites every prose field of the helper's record, the title included", () => {
    const a: StoredAnnotation = {
      title: "Ada at the lake",
      caption: "Ada wading in",
      description: "Ada and Ben at the lake. Ada's dog swims.",
      tags: ["ada", "lake", "adapter"],
      place: "Ada's cabin",
      activity: "Ada swimming",
      objects: ["ada's hat", "boat"],
      visibleText: "ADA",
      season: "summer",
      mood: "Ada is happy",
      searchSummary: "ada lake swim",
    };
    const out = scrubAnnotation(a, "Ada");
    expect(JSON.stringify(out).toLowerCase()).not.toMatch(/\bada\b/);
    expect(out).toMatchObject({ title: "A family member at the lake", tags: ["lake", "adapter"], objects: ["boat"], season: "summer" });
  });
});
