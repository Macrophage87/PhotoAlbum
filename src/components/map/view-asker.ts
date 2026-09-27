import type { MapPhotos } from "@/lib/map/geojson";
import type { MapViewport } from "@/lib/map/view";

/** A view made half as wide again on every side, so a small pan stays inside what was already sent. */
export function widen(v: MapViewport): MapViewport {
  const w = v.east - v.west;
  const h = v.north - v.south;
  const wide = w * 2 >= 360;
  return { west: wide ? -180 : v.west - w / 2, east: wide ? 180 : v.east + w / 2, south: Math.max(-90, v.south - h / 2), north: Math.min(90, v.north + h / 2), zoom: v.zoom };
}

const covers = (a: MapViewport, b: MapViewport) => a.west <= b.west && a.east >= b.east && a.south <= b.south && a.north >= b.north;

/** How long a map has to stay put before its view is asked for, so a drag asks once rather than all the way along. */
export const VIEW_SETTLE_MS = 250;

/**
 * Asks for the photographs of each view a map settles on, and hands over only the answer to the latest question.
 *
 * A view already answered is not asked again: an answer of single photographs stays good anywhere inside the (widened)
 * view it was for, and an answer of groups until the zoom changes, since groups are only right for the zoom they were
 * made for. Every question is numbered, and an answer to any but the latest is dropped. So is a question in flight
 * when the map comes back to what is already on it: its answer would be for somewhere the map no longer is, and would
 * put that place's photographs where these should be.
 */
export function viewAsker({ fetchView, onAnswer, settleMs = VIEW_SETTLE_MS }: { fetchView: (view: MapViewport, signal: AbortSignal) => Promise<MapPhotos>; onAnswer: (photos: MapPhotos) => void; settleMs?: number }) {
  /** What the photographs on the map are the answer for. */
  let shown: { view: MapViewport; grouped: boolean } | null = null;
  /** The last view the map settled on. */
  let last: MapViewport | null = null;
  let latest = 0;
  /** How many questions have been sent, so an answer can say whether its question went after a given moment. */
  let sent = 0;
  /** Waiting for the first answer to any question sent after `after`. */
  let waiters: { after: number; resolve: (drawn: boolean) => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: AbortController | null = null;

  /** Take back whatever question is waiting or in flight: its answer, if it comes, is no longer wanted. */
  const withdraw = () => {
    latest++;
    if (timer) clearTimeout(timer);
    timer = null;
    pending?.abort();
    pending = null;
  };

  const send = (v: MapViewport) => {
    const mine = latest;
    const number = ++sent;
    const ctl = new AbortController();
    pending = ctl;
    const wide = widen(v);
    fetchView(wide, ctl.signal)
      .then((photos) => {
        if (mine !== latest) return;
        pending = null;
        shown = { view: wide, grouped: photos.cells.length > 0 };
        onAnswer(photos);
        const done = waiters.filter((w) => number > w.after);
        waiters = waiters.filter((w) => number <= w.after);
        for (const w of done) w.resolve(true);
      })
      // Given up for a newer view, or failed: the map keeps what it has, and the next move asks again.
      .catch(() => {});
  };

  return {
    /** The map has settled on `v`. */
    ask(v: MapViewport) {
      last = v;
      withdraw();
      if (shown && covers(shown.view, v) && (!shown.grouped || Math.floor(shown.view.zoom) === Math.floor(v.zoom))) return;
      const mine = latest;
      timer = setTimeout(() => {
        timer = null;
        if (mine === latest) send(v);
      }, settleMs);
    },
    /**
     * Ask for the view the map is on again, now, whatever was answered before: the album has changed under it.
     * Resolves (true) with the first answer drawn to any question sent from now on — this one's, or a later view's
     * if the map is moved before it comes — or at once (false) when there is no view to ask about.
     */
    refresh(): Promise<boolean> {
      withdraw();
      shown = null;
      if (!last) return Promise.resolve(false);
      const drawn = new Promise<boolean>((resolve) => waiters.push({ after: sent, resolve }));
      send(last);
      return drawn;
    },
    dispose() {
      withdraw();
      for (const w of waiters) w.resolve(false);
      waiters = [];
    },
  };
}
