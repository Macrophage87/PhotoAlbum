import { describe, expect, it } from "vitest";
import { nameMatcher } from "@/lib/people/scrub";
import { looseMatcher } from "@/lib/people/forget";

/**
 * Names in what members type without thinking of it as prose — file names, web addresses, place names, a
 * relationship — for a forget's leftover list and the queue's file names. A full name counts written apart in any
 * case, or run together as whole word pieces; a relative's lookalike name never does.
 */
describe("a forgotten name in file names, web addresses and the like", () => {
  const looks = (name: string) => looseMatcher(nameMatcher([name], []));

  it("finds the name spelled apart or run together", () => {
    const zeb = looks("Zebulon Quince");
    for (const t of ["zebulonquince80", "ZebulonQuince.jpg", "zebulon-quince-80th", "Zebulon_Quince_cake", "ZEBULON QUINCE 80.JPG", "Zebulon Quince's cabin", "Zebulon Quince’s sister"]) expect([t, zeb(t)]).toEqual([t, true]);
  });

  it("folds letters that have no plain spelling of their own", () => {
    const lukasz = looks("Łukasz Nowak");
    for (const t of ["Lukasz Nowak", "LukaszNowak.jpg", "lukasz-nowak-80th", "Łukasz Nowak's bike"]) expect([t, lukasz(t)]).toEqual([t, true]);
    expect(looks("Søren Bjørn")("soren_bjorn.jpg")).toBe(true);
    expect(looks("Æsa Groß")("AesaGross.gpx")).toBe(true);
  });

  it("never counts a first name alone, in a place's, a track's or an album's name in title case", () => {
    const rows: [string, string][] = [
      ["Leo Martin", "Leo Martinez Park"],
      ["Barbara Jones", "Santa Barbara Pier"],
      ["Ian Lee", "Ian Leeds Park"],
      ["Mary Ann", "Mary Anne Park"],
      ["Sean O'Neil", "Sean O'Neill Park"],
      ["Ava DeLuca", "Ava DeLucas Park"],
    ];
    for (const [name, t] of rows) expect([name, t, looks(name)(t)]).toEqual([name, t, false]);
  });

  it("never runs together a two-word first name that is a given name of its own", () => {
    expect(looks("Mary Ann")("Maryann.jpg")).toBe(false);
    expect(looks("Anna Belle")("annabelle-80th")).toBe(false);
    expect(looks("Anna Belle")("Anna Belle's party")).toBe(true);
  });

  it("never flags a relative's or anybody's lookalike name", () => {
    const rows: [string, string[]][] = [
      ["Ian Smith", ["Brian Smith", "Adrian Smith", "Julian Smith"]],
      ["Dan Brown", ["Jordan Brown", "Aidan Brown"]],
      ["Ann Jones", ["Joann Jones", "Leann Jones"]],
      ["Leo Martin", ["Leo Martinez"]],
      ["Rose Mary", ["rosemary"]],
      ["Mary Land", ["Maryland"]],
      ["Holly Wood", ["Hollywood"]],
    ];
    for (const [name, others] of rows) {
      const test = looks(name);
      for (const other of others) {
        const run = other.replace(/\s+/g, "");
        // As a file name, a place name, a web address and a relationship.
        for (const t of [`${other}.jpg`, `${run.toLowerCase()}80.jpg`, `${run}.jpg`, `${other.toLowerCase().replace(/\s+/g, "-")}-80th`, `${other}'s cabin`, `${other}'s sister`, `${other.replace(/\s+/g, "_")}_cake`]) {
          expect([name, t, test(t)]).toEqual([name, t, false]);
        }
      }
    }
  });
});
