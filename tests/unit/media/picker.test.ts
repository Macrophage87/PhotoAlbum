import { describe, expect, it } from "vitest";
import { albumTakes, extensionOf, isScanPick, isVideoPick, mimeOfPicked, refusalFor } from "@/lib/media/picker";

/**
 * What the uploader accepts once the file chooser has stopped narrowing anything. Nothing may be turned away for
 * having no type, because that is exactly what a phone does with a file out of its own storage.
 */
describe("deciding what a chosen file is", () => {
  it("takes a photograph the phone gave no type for", () => {
    expect(albumTakes({ name: "IMG_4821.HEIC", type: "" })).toBe(true);
    expect(mimeOfPicked({ name: "IMG_4821.HEIC", type: "" })).toBe("image/heic");
  });

  it("takes a clip that arrived from the files app as a generic blob", () => {
    const mov = { name: "beach.MOV", type: "application/octet-stream" };
    expect(albumTakes(mov)).toBe(true);
    expect(isVideoPick(mov)).toBe(true);
    expect(isScanPick(mov)).toBe(false);
  });

  it("takes a scanner's mesh, which browsers name nothing at all", () => {
    const glb = { name: "kitchen.glb", type: "" };
    expect(isScanPick(glb)).toBe(true);
    // A scan is not a clip, so it must never be measured for length before it is sent.
    expect(isVideoPick(glb)).toBe(false);
  });

  it("still takes a photograph whose name has no extension, on the type alone", () => {
    expect(mimeOfPicked({ name: "scan0001", type: "image/jpeg" })).toBe("image/jpeg");
  });

  it("turns away what the album does not keep, and says which file it was", () => {
    const pdf = { name: "tickets.pdf", type: "application/pdf" };
    expect(albumTakes(pdf)).toBe(false);
    expect(refusalFor(pdf)).toContain(".pdf");
    expect(refusalFor({ name: "notes", type: "" })).toContain("this kind of file");
  });

  it("reads the extension whatever the case, and copes with dots in the name", () => {
    expect(extensionOf("Holiday.2025.jpeg")).toBe("jpeg");
    expect(extensionOf("noextension")).toBe("");
  });
});
