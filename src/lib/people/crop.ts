/** How much room to leave around a face box, as a fraction of its longest side: a face needs its hair and chin. */
export const FACE_PAD = 0.35;

export type FaceCrop = { widthPct: number; heightPct: number; leftPct: number; topPct: number };

/**
 * Where to put a photograph inside a small square so that one face fills it, given the face's box as fractions of
 * the image and the image's own aspect (width ÷ height).
 *
 * Every number returned is a percentage of the *square*, not of the picture, which is the whole point. The first
 * version of this positioned the picture with `transform: translate(%)`, where a percentage means a share of the
 * element being moved — and the element is the picture, blown up to several times the square. Every face was
 * therefore shoved two or three times too far and the square showed a flat patch of jumper or sky, which is the
 * grey circle people were looking at.
 *
 * The aspect matters because the box's width is a fraction of the image's width and its height a fraction of its
 * height: on a 3:2 photograph those are different numbers of pixels, and a crop that ignores it stretches the face.
 */
export function faceCrop(box: [number, number, number, number], aspect = 1, pad = FACE_PAD): FaceCrop {
  const [x, y, w, h] = box;
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  // Work in pixels of an image `ratio` wide and 1 tall, so the two sides are comparable, then square off the longer.
  const side = Math.max(w * ratio, h) * (1 + pad);
  // The window back in fractions of the image, never wider or taller than the picture itself.
  const windowW = Math.min(1, side / ratio);
  const windowH = Math.min(1, side);
  // Keep the window on the picture: a face at the very edge slides in rather than showing a band of nothing.
  const left = clamp(x + w / 2 - windowW / 2, 0, 1 - windowW);
  const top = clamp(y + h / 2 - windowH / 2, 0, 1 - windowH);
  return {
    widthPct: 100 / windowW,
    heightPct: 100 / windowH,
    leftPct: -(left / windowW) * 100,
    topPct: -(top / windowH) * 100,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
