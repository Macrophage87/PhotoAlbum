import { describe, expect, it } from "vitest";
import { facebookShareUrl, shareableTripUrl } from "@/lib/share/social";

const app = "https://album.example.com";

describe("shareableTripUrl", () => {
  it("uses the plain trip URL for public trips", () => {
    expect(shareableTripUrl({ slug: "acadia", visibility: "PUBLIC", shareToken: null }, app)).toBe("https://album.example.com/trips/acadia");
  });
  it("uses the secret link for link-shared trips", () => {
    expect(shareableTripUrl({ slug: "acadia", visibility: "LINK", shareToken: "abc" }, app)).toBe("https://album.example.com/share/abc");
  });
  it("returns null for private trips and for link trips without a token", () => {
    expect(shareableTripUrl({ slug: "acadia", visibility: "PRIVATE", shareToken: "abc" }, app)).toBeNull();
    expect(shareableTripUrl({ slug: "acadia", visibility: "LINK", shareToken: null }, app)).toBeNull();
  });
});

describe("facebookShareUrl", () => {
  it("points at the sharer dialog with the URL encoded", () => {
    expect(facebookShareUrl("https://album.example.com/trips/acadia?x=1")).toBe(
      "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Falbum.example.com%2Ftrips%2Facadia%3Fx%3D1",
    );
  });
});
