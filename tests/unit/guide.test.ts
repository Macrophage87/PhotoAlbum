import { describe, expect, it } from "vitest";
import guide from "@/lib/guide/content.json";
import { inlineRuns, type Guide } from "@/lib/guide/types";

const G = guide as Guide;
const KINDS = new Set(["p", "h3", "note", "small", "bullets", "steps", "table"]);

describe("the family's guide", () => {
  it("is made only of blocks both the page and the print know how to draw", () => {
    // The page renders this JSON and so does scripts/make-guide-pdf.py. A kind neither knows is a section that
    // silently goes missing from one of them, which is exactly the drift keeping the words in one file avoids.
    const blocks = [...G.intro, ...G.sections.flatMap((s) => s.blocks)];
    expect(blocks.length).toBeGreaterThan(20);
    for (const block of blocks) expect(KINDS.has(block.kind)).toBe(true);
  });

  it("gives every section its own anchor, so the contents can jump to it", () => {
    const ids = G.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z-]*$/);
  });

  it("keeps every table rectangular", () => {
    for (const section of G.sections) {
      for (const block of section.blocks) {
        if (block.kind !== "table") continue;
        for (const row of block.rows) expect(row.length).toBe(block.columns.length);
      }
    }
  });

  it("still explains how to get in, which is the one thing a reader cannot look up in the album itself", () => {
    const first = G.sections[0];
    expect(first.heading).toMatch(/getting in/i);
    expect(JSON.stringify(first)).toMatch(/password/i);
  });
});

describe("the guide's two marks of inline markup", () => {
  it("splits bold and italic out of plain words", () => {
    expect(inlineRuns("Press **Upload** in the menu")).toEqual([
      { text: "Press " },
      { text: "Upload", bold: true },
      { text: " in the menu" },
    ]);
    expect(inlineRuns("try _lobster_")).toEqual([{ text: "try " }, { text: "lobster", italic: true }]);
  });

  it("leaves text with no marks, and unmatched marks, exactly as it was typed", () => {
    expect(inlineRuns("plain words")).toEqual([{ text: "plain words" }]);
    expect(inlineRuns("2 ** 8 is not bold")).toEqual([{ text: "2 ** 8 is not bold" }]);
  });

  it("reassembles to the original text whatever the marks are", () => {
    for (const s of ["**a** and _b_", "no marks", "**one**", "_two_ **three** four"]) {
      expect(inlineRuns(s).map((r) => r.text).join("")).toBe(s.replace(/\*\*|_/g, ""));
    }
  });
});
