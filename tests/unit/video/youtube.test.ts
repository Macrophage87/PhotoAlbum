import { describe, expect, it } from "vitest";
import { embedUrl, parseIsoDuration, parseYouTubeUrl } from "@/lib/video/youtube";

describe("parseYouTubeUrl", () => {
  const id = "dQw4w9WgXcQ";
  it.each([
    [`https://www.youtube.com/watch?v=${id}`],
    [`https://youtube.com/watch?v=${id}&t=42s&list=PL123`],
    [`https://m.youtube.com/watch?feature=share&v=${id}`],
    [`https://youtu.be/${id}`],
    [`https://youtu.be/${id}?si=abc`],
    [`https://www.youtube.com/shorts/${id}`],
    [`https://www.youtube.com/live/${id}?feature=share`],
    [`https://www.youtube.com/embed/${id}`],
    [`https://www.youtube-nocookie.com/embed/${id}`],
    [`youtube.com/watch?v=${id}`],
    [`  https://youtu.be/${id}  `],
    [id],
  ])("accepts %s", (url) => {
    expect(parseYouTubeUrl(url)).toBe(id);
  });
  it.each([
    ["https://vimeo.com/123456"],
    ["https://example.com/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=tooshort"],
    ["https://www.youtube.com/watch"],
    ["https://www.youtube.com/channel/UC123"],
    ["javascript:alert(1)"],
    ["not a url"],
    [""],
    ["https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"],
  ])("rejects %s", (url) => {
    expect(parseYouTubeUrl(url)).toBeNull();
  });
});

describe("embed and duration helpers", () => {
  it("embeds through the privacy-enhanced host", () => {
    expect(embedUrl("dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&autoplay=1");
  });
  it("parses ISO 8601 durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("P1DT1M")).toBe(86460);
    expect(parseIsoDuration("nonsense")).toBeNull();
  });
});
