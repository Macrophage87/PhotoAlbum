import { describe, expect, it } from "vitest";
import { toGridPhoto } from "@/components/photos/toGrid";
import type { PhotoCard } from "@/lib/photos/queries";

/**
 * The lightbox's "Tag a pet" (and a scan's first still) changes the item, which is its uploader's and an admin's to
 * do: the server has always refused anybody else, so the button is not offered to them either.
 */
describe("who is offered tagging from the lightbox", () => {
  const card = (extra: Partial<PhotoCard> = {}) => ({ id: "p1", uploaderId: "uploader", kind: "PHOTO", status: "READY", updatedAt: new Date(), edits: null, renditions: null, uploader: { name: "Jo", email: "jo@example.com" }, collections: [], ...extra }) as unknown as PhotoCard;
  const uploader = { id: "uploader", role: "MEMBER" as const };
  const relative = { id: "relative", role: "MEMBER" as const };
  const admin = { id: "admin", role: "ADMIN" as const };

  it("offers it to the uploader and to an admin", () => {
    expect(toGridPhoto(card(), null, uploader).canTag).toBe(true);
    expect(toGridPhoto(card(), null, admin).canTag).toBe(true);
  });

  it("does not offer it to another member, who still reads the members' layer, nor to anybody signed out", () => {
    const theirs = toGridPhoto(card(), null, relative);
    expect(theirs.canTag).toBe(false);
    expect(theirs.uploadedBy).toBe("Jo");
    expect(toGridPhoto(card()).canTag).toBe(false);
  });

  it("waits for the item to be ready, for anybody", () => {
    expect(toGridPhoto(card({ status: "PROCESSING" }), null, uploader).canTag).toBe(false);
  });
});
