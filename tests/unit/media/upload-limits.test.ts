import { describe, expect, it } from "vitest";
import { maxUploadBytes, tooBigMessage } from "@/lib/media/limits";
import { statusAfterUpload } from "@/lib/media/upload-one";

const limits = { photo: 100 * 1048576, video: 1024 * 1048576, scan: 800 * 1048576 };

describe("upload size limits", () => {
  it("holds each kind to its own limit, a scan included", () => {
    expect(maxUploadBytes("image/jpeg", limits)).toBe(limits.photo);
    expect(maxUploadBytes("video/mp4", limits)).toBe(limits.video);
    expect(maxUploadBytes("application/x-ply", limits)).toBe(limits.scan);
    expect(maxUploadBytes("model/gltf-binary", limits)).toBe(limits.scan);
  });
  it("names the size and the limit", () => {
    expect(tooBigMessage(250 * 1048576, limits.photo)).toBe("This file is 250 MB; the album takes files of this kind up to 100 MB.");
  });
});

describe("what a tile shows once its file has arrived", () => {
  it("watches a new upload, and a file the album had until that one is ready", () => {
    expect(statusAfterUpload({})).toBe("processing");
    expect(statusAfterUpload({ duplicate: false, status: "PENDING" })).toBe("processing");
    expect(statusAfterUpload({ duplicate: true, status: "READY" })).toBe("ready");
    expect(statusAfterUpload({ duplicate: true, status: "PROCESSING" })).toBe("processing");
    expect(statusAfterUpload({ duplicate: true, status: "FAILED" })).toBe("processing");
  });
});

describe("the type a file is filed under when sent", () => {
  it("is the browser's when the album takes it, else the one its name says, as the upload route decides", async () => {
    const { mimeAsSent } = await import("@/lib/media/picker");
    expect(mimeAsSent({ name: "splat.ply", type: "application/octet-stream" })).toBe("application/x-ply");
    expect(mimeAsSent({ name: "clip.mov", type: "" })).toBe("video/quicktime");
    expect(mimeAsSent({ name: "odd.jpg", type: "image/png" })).toBe("image/png");
    expect(mimeAsSent({ name: "notes.pdf", type: "application/pdf" })).toBeNull();
  });
});
