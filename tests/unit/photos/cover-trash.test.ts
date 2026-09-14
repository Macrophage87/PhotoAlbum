import { describe, expect, it } from "vitest";
import { coverUnlessTrashed } from "@/lib/photos/cover";

/**
 * A cover is chosen once and then remembered, which is exactly why trashing the photograph has to be noticed where
 * the cover is read: otherwise a trip goes on leading with it on the front page, and Facebook goes on drawing it,
 * long after somebody decided it should not be in the album.
 */
describe("a cover that has been trashed", () => {
  const cover = { id: "p1", updatedAt: new Date(), width: 1200, height: 800 };

  it("still counts while it is in the album", () => {
    expect(coverUnlessTrashed({ ...cover, trashedAt: null })).toMatchObject({ id: "p1" });
  });

  it("stops counting the moment it is in the trash, so the album chooses another", () => {
    expect(coverUnlessTrashed({ ...cover, trashedAt: new Date() })).toBeNull();
  });

  it("counts again if it is restored, because nothing was thrown away to make it stop", () => {
    const trashed = { ...cover, trashedAt: new Date() };
    expect(coverUnlessTrashed(trashed)).toBeNull();
    expect(coverUnlessTrashed({ ...trashed, trashedAt: null })).toMatchObject({ id: "p1" });
  });

  it("copes with no cover having been chosen at all", () => {
    expect(coverUnlessTrashed(null)).toBeNull();
    expect(coverUnlessTrashed(undefined)).toBeNull();
  });
});
