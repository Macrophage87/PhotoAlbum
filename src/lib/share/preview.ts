import type { Metadata } from "next";
import { photoUrl } from "@/lib/photos/urls";
import { RENDITION_SIZES } from "@/lib/images/renditions";

/**
 * The card a link brings with it.
 *
 * Paste a link into Facebook, Messages, WhatsApp, Slack or a mail client and something goes and reads the page for
 * a title, a line of description and a picture. This builds that, and gets the parts right that are easy to get
 * wrong: the picture has to be an absolute URL that an anonymous crawler can actually fetch, and it has to say how
 * big it is, or the card is drawn small or not at all.
 *
 * A secret link carries its token on the picture's URL too, because a crawler has no cookie. That hands the token
 * to whatever is drawing the preview — which is the same thing as posting the link there in the first place.
 */

export type PreviewCover = { id: string; updatedAt: Date | string; width?: number | null; height?: number | null } | null;

/** What the album puts on a card, in the shape Next wants for `openGraph` and `twitter`. */
export function previewCard(opts: {
  title: string;
  description: string;
  pageUrl: string;
  cover: PreviewCover;
  appUrl: string;
  /** A LINK share's token, so the crawler can fetch the cover without a cookie. */
  shareToken?: string;
  shareKind?: "trip" | "collection";
}): { openGraph: Metadata["openGraph"]; twitter: Metadata["twitter"] } {
  const images = opts.cover ? [coverImage(opts.cover, opts.title, opts.appUrl, opts.shareToken, opts.shareKind)] : [];
  return {
    openGraph: { type: "website", siteName: "Family Album", title: opts.title, description: opts.description, url: opts.pageUrl, images },
    // The same picture again, as the networks that read Twitter's tags expect it, so those draw it large too.
    twitter: { card: images.length ? "summary_large_image" : "summary", title: opts.title, description: opts.description, images: images.map((i) => i.url) },
  };
}

function coverImage(cover: NonNullable<PreviewCover>, alt: string, appUrl: string, shareToken?: string, shareKind?: "trip" | "collection") {
  const share = shareToken ? `&share=${encodeURIComponent(shareToken)}&kind=${shareKind ?? "trip"}` : "";
  const url = new URL(`${photoUrl({ id: cover.id, updatedAt: cover.updatedAt }, "medium")}${share}`, appUrl).toString();
  // The rendition is scaled to fit a square of this side, so the long edge is known and the short one follows the
  // original's shape. Where the album never learned the shape, the long edge alone is still better than nothing.
  const long = RENDITION_SIZES.medium;
  const ratio = cover.width && cover.height ? cover.width / cover.height : null;
  const [width, height] = ratio === null ? [long, long] : ratio >= 1 ? [long, Math.round(long / ratio)] : [Math.round(long * ratio), long];
  return { url, width, height, alt };
}
