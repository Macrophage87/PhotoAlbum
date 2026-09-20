import { describe, expect, it } from "vitest";
import { whoWasThere } from "@/lib/photos/assign";
import { participantsFromForm } from "@/lib/trips/validation";

describe("filing a photograph only where its uploader was", () => {
  it("lets a trip with nobody named take anybody's photographs, as every trip did before this", () => {
    // The `none` arm is what keeps an album that never uses this feature behaving exactly as it always has.
    expect(whoWasThere("u1")).toEqual({ OR: [{ participants: { none: {} } }, { participants: { some: { id: "u1" } } }] });
  });

  it("asks the same question of a trip and of an outing, since a clock misfiles both the same way", () => {
    expect(whoWasThere("u2").OR[1]).toEqual({ participants: { some: { id: "u2" } } });
  });
});

describe("reading who a form says was there", () => {
  const form = (entries: [string, string][]) => {
    const fd = new FormData();
    for (const [k, v] of entries) fd.append(k, v);
    return fd;
  };

  it("is null when the form does not carry the control, so an older page cannot wipe the list", () => {
    expect(participantsFromForm(form([["title", "Acadia"]]))).toBeNull();
  });

  it("is empty when the control is there and nobody is ticked, which means everyone", () => {
    // Empty and null must stay distinguishable: one clears the list, the other leaves it alone.
    expect(participantsFromForm(form([["participantsPresent", "1"]]))).toEqual([]);
  });

  it("collects the ticked members, without repeats or blanks", () => {
    const fd = form([
      ["participantsPresent", "1"],
      ["participants", "u1"],
      ["participants", "u2"],
      ["participants", "u1"],
      ["participants", ""],
    ]);
    expect(participantsFromForm(fd)).toEqual(["u1", "u2"]);
  });
});
