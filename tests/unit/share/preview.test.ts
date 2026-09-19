import { describe, expect, it } from "vitest";
import { previewCard } from "@/lib/share/preview";

const cover = { id: "photo1", updatedAt: new Date("2025-08-12T12:00:00Z"), width: 4000, height: 3000 };
const base = { title: "Acadia, Maine", description: "Aug 10 – 16, 2025", pageUrl: "https://album.example/trips/acadia", appUrl: "https://album.example" };

describe("the card a shared link carries", () => {
  it("names the thing, says a line about it, and points at a cover an outsider can fetch", () => {
    const { openGraph } = previewCard({ ...base, cover });
    expect(openGraph).toMatchObject({ type: "website", siteName: "Family Album", title: "Acadia, Maine", description: "Aug 10 – 16, 2025", url: base.pageUrl });
    const image = (openGraph as { images: { url: string; width: number; height: number; alt: string }[] }).images[0];
    expect(image.url.startsWith("https://album.example/api/photos/photo1/preview?v=")).toBe(true);
    expect(image.alt).toBe("Acadia, Maine");
  });

  it("asks for the picture as JPEG, and says so, because the things that draw cards will not draw WebP", () => {
    // Everything the album stores is WebP. Facebook, Messenger and WhatsApp show nothing at all for a WebP card
    // picture, which reads to whoever was sent the link as an album with no photographs in it.
    const image = (previewCard({ ...base, cover }).openGraph as { images: { url: string; type: string }[] }).images[0];
    expect(image.url).toContain("/preview?");
    expect(image.url).not.toContain("/medium?");
    expect(image.type).toBe("image/jpeg");
  });

  it("says how big the picture is, which is what decides whether the card is drawn large", () => {
    const landscape = previewCard({ ...base, cover });
    const wide = (landscape.openGraph as { images: { width: number; height: number }[] }).images[0];
    expect(wide.width).toBe(1600);
    expect(wide.height).toBe(1200);

    const portrait = previewCard({ ...base, cover: { ...cover, width: 3000, height: 4000 } });
    const tall = (portrait.openGraph as { images: { width: number; height: number }[] }).images[0];
    expect(tall.width).toBe(1200);
    expect(tall.height).toBe(1600);

    // A cover whose shape the album never learned still gets a size, which beats leaving it out.
    const unknown = previewCard({ ...base, cover: { id: "x", updatedAt: new Date(), width: null, height: null } });
    expect((unknown.openGraph as { images: { width: number }[] }).images[0].width).toBe(1600);
  });

  it("asks for the large card where there is a picture, and the small one where there is not", () => {
    expect(previewCard({ ...base, cover }).twitter).toMatchObject({ card: "summary_large_image" });
    const bare = previewCard({ ...base, cover: null });
    expect(bare.twitter).toMatchObject({ card: "summary" });
    expect((bare.openGraph as { images: unknown[] }).images).toEqual([]);
  });

  it("carries a secret link's token on the picture too, since a crawler has no cookie", () => {
    const { openGraph } = previewCard({ ...base, cover, shareToken: "s3cret", shareKind: "collection" });
    const url = (openGraph as { images: { url: string }[] }).images[0].url;
    expect(url).toContain("&share=s3cret");
    expect(url).toContain("&kind=collection");
  });
});
