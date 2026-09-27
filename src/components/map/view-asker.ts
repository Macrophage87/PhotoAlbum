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

  const send = (v: MapViewport): Promise<boolean> => {
    const mine = latest;
    const ctl = new AbortController();
    pending = ctl;
    const wide = widen(v);
    return fetchView(wide, ctl.signal)
      .then((photos) => {
        if (mine !== latest) return false;
        pending = null;
        shown = { view: wide, grouped: photos.cells.length > 0 };
        onAnswer(photos);
        return true;
      })
      // Given up for a newer view, or failed: the map keeps what it has, and the next move asks again.
      .catch(() => false);
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
        if (mine === latest) void send(v);
      }, settleMs);
    },
    /** Ask for the view the map is on again, now, whatever was answered before: the album has changed under it. Resolves once the answer is on the map (true), or when there is none to be had (false). */
    refresh(): Promise<boolean> {
      withdraw();
      shown = null;
      return last ? send(last) : Promise.resolve(false);
    },
    dispose: withdraw,
  };
}
