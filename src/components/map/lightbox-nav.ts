/** How many photographs on either side of the one on screen are looked up ahead of a press. */
export const LOOK_AHEAD = 3;

/**
 * Where a map's lightbox is, moved at once by every press.
 *
 * The photograph on screen is never waited for: a step moves straight on, drawn as a placeholder until its picture is
 * known, and the ones around it are looked up meanwhile (`prefetch`). So three quick presses are three photographs
 * on, however slow the answers. A photograph that turns out not to be there any more (`isGone`: trashed, or made
 * private, since the map was sent) is stepped past in the direction of travel, when a step lands on it or when the
 * answer that says so comes in (`recheck`). `onShow` is told where the lightbox is, or -1 when nothing is left to show.
 */
export function lightboxNav({ ids, start, isGone, onShow, prefetch }: { ids: string[]; start: number; isGone: (id: string) => boolean; onShow: (index: number) => void; prefetch: (ids: string[]) => void }) {
  const n = ids.length;
  let index = start;
  let dir: 1 | -1 = 1;
  const around = (i: number) => [...new Set(Array.from({ length: 2 * LOOK_AHEAD + 1 }, (_, k) => ids[(((i + k - LOOK_AHEAD) % n) + n) % n]))];
  const show = () => {
    for (let tries = 0; tries < n; tries++) {
      if (!isGone(ids[index])) {
        onShow(index);
        prefetch(around(index));
        return;
      }
      index = (index + dir + n) % n;
    }
    onShow(-1);
  };
  return {
    open: show,
    step(d: 1 | -1) {
      dir = d;
      index = (index + d + n) % n;
      show();
    },
    /** Some photographs were just found gone: move off the one on screen if it is one of them. */
    recheck() {
      if (isGone(ids[index])) show();
    },
    get index() {
      return index;
    },
  };
}
