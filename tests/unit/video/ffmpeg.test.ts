import { describe, expect, it } from "vitest";
import { parseProbe, posterArgs, transcodeArgs, videoFilter } from "@/lib/video/ffmpeg";
import { parseRange } from "@/app/api/photos/[id]/[size]/route";

describe("parseProbe", () => {
  it("reads duration, size, rotation, HDR and creation time", () => {
    const p = parseProbe({
      format: { duration: "12.5", tags: { creation_time: "2025-08-12T14:03:00.000000Z" } },
      streams: [{ codec_type: "audio" }, { codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, color_transfer: "arib-std-b67", color_primaries: "bt2020", side_data_list: [{ rotation: -90 }] }],
    });
    expect(p).toMatchObject({ durationS: 12.5, width: 3840, height: 2160, rotation: 270, hdr: true, videoCodec: "hevc" });
    expect(p.createdAt?.toISOString()).toBe("2025-08-12T14:03:00.000Z");
  });
  it("copes with missing fields", () => {
    expect(parseProbe({})).toEqual({ durationS: null, width: null, height: null, rotation: 0, hdr: false, createdAt: null, videoCodec: null });
  });
});

describe("ffmpeg arguments", () => {
  it("tone-maps only HDR sources", () => {
    expect(videoFilter({ hdr: false })).not.toContain("tonemap");
    expect(videoFilter({ hdr: true })).toContain("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p");
  });
  it("produces a faststart H.264 MP4 capped at 1080p with a fast preset", () => {
    const args = transcodeArgs("in.mov", "out.mp4", { hdr: false });
    expect(args).toContain("libx264");
    expect(args[args.indexOf("-preset") + 1]).toBe("veryfast");
    expect(args[args.indexOf("-crf") + 1]).toBe("22");
    expect(args).toContain("+faststart");
    expect(args[args.indexOf("-vf") + 1]).toContain("min(1920,iw)");
  });
  it("takes the poster at ten percent, clamped inside the clip", () => {
    expect(posterArgs("v.mp4", "p.jpg", 30)[posterArgs("v.mp4", "p.jpg", 30).indexOf("-ss") + 1]).toBe("3.00");
    expect(posterArgs("v.mp4", "p.jpg", null)[posterArgs("v.mp4", "p.jpg", null).indexOf("-ss") + 1]).toBe("0.00");
  });
});

describe("parseRange", () => {
  it("handles open, closed and suffix ranges", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
  });
  it("rejects unsatisfiable or malformed ranges", () => {
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=20-10", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });
});
