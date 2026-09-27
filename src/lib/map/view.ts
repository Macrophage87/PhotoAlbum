/**
 * The part of a map somebody is looking at, and how the photographs in it are sent.
 *
 * A map of the whole album used to be sent every photograph it held, whatever was on screen: twelve thousand pins
 * came to megabytes on every visit, nearly all of them drawn on top of each other at the zoom it opens at. Past
 * `POINT_LIMIT` a map is asked for one view at a time instead. Up to the limit the view's photographs come one by
 * one and the browser groups them as it always has; past it they come already grouped, into cells a little bigger
 * than a group the browser would draw, each with its count. Nothing is left out either way: a cell says how many
 * are in it, and zooming in on it splits it.
 */

/** Most photographs sent one by one in a single answer. Past this, the answer is grouped into cells. */
export const POINT_LIMIT = 1500;
/** How wide a cell is on screen at the zoom it was asked for, in pixels (the browser groups within 48). */
export const CELL_PX = 64;
/** Most cells in one answer; a view that would need more is grouped more coarsely. */
export const MAX_CELLS = 400;
/** Most photographs described in one request for their details (`/api/map/photos`): a heap of pins lists at most sixty. */
export const MAX_DESCRIBED = 100;
/** MapLibre's tiles are 512 pixels across. */
const TILE_PX = 512;
/** Past this a zoom means nothing on the ground, and a zoom that large would only make cells nobody can see. */
const MAX_ZOOM = 24;

export type MapViewport = { west: number; south: number; east: number; north: number; zoom: number };

/**
 * `bbox=west,south,east,north&zoom=z` from a map's address, or null when it asks for no view (the whole map).
 * "bad" when it tries and gets it wrong, so the caller can say so rather than quietly send everything.
 */
export function parseViewport(sp: URLSearchParams): MapViewport | null | "bad" {
  const bbox = sp.get("bbox");
  const zoom = sp.get("zoom");
  if (bbox === null && zoom === null) return null;
  const raw = (bbox ?? "").split(",");
  const parts = raw.map(Number);
  const z = Number(zoom);
  // Number("") is 0, so an empty value is refused before it can pass for the equator or zoom 0.
  if (parts.length !== 4 || raw.some((v) => !v.trim()) || !parts.every(Number.isFinite) || !zoom?.trim() || !Number.isFinite(z)) return "bad";
  const [west, south, east, north] = parts;
  if (south > north || east < west) return "bad";
  return { west, south: Math.max(-90, south), east, north: Math.min(90, north), zoom: Math.min(MAX_ZOOM, Math.max(0, z)) };
}

/**
 * Whether a position is in view. A map panned across the date line reports longitudes past ±180, so longitude is
 * measured from the west edge round the globe rather than compared as a plain number.
 */
export function inViewport(v: MapViewport, lat: number, lng: number): boolean {
  if (lat < v.south || lat > v.north) return false;
  const span = v.east - v.west;
  if (span >= 360) return true;
  const from = (((lng - v.west) % 360) + 360) % 360;
  return from <= span;
}

/** Web Mercator, as the map draws it: 0 to 1 across the world, west to east and north to south. */
export function mercator(lat: number, lng: number): [number, number] {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

/** Past this zoom a cell is a few metres across, finer than any pin; it also keeps a cell's number exact. */
const MAX_GRID_ZOOM = 20;

/** A group of positions sent as one: where to draw it (the middle of what is in it), how many, and the box they fill. */
export type Cell<R> = { lat: number; lng: number; n: number; box: [number, number, number, number]; members: R[] };

/**
 * Group positions into square cells `CELL_PX` wide at this zoom. Each position comes with its place on the Mercator
 * square (`x`, `y`), worked out once for the map rather than on every view. When that would still be more than
 * `MAX_CELLS`, the cells are made twice as wide until it is not, so a bad zoom in the address cannot make the answer
 * as big as the album.
 */
export function gridCells<R extends { lat: number; lng: number; x: number; y: number }>(rows: R[], zoom: number): Cell<R>[] {
  for (let z = Math.min(Math.floor(zoom), MAX_GRID_ZOOM); ; z--) {
    const across = (TILE_PX * 2 ** z) / CELL_PX;
    // The edges of the square belong to the cells inside them: a pole sits exactly on the bottom edge (or a hair past
    // the top), and a row past the last would be numbered as the first row of the next column over.
    const at = (v: number) => Math.min(across - 1, Math.max(0, Math.floor(v * across)));
    const cells = new Map<number, Cell<R>>();
    for (const r of rows) {
      const key = at(r.x) * across + at(r.y);
      const c = cells.get(key);
      // The middle is summed here and divided once the cell is whole.
      if (!c) cells.set(key, { lat: r.lat, lng: r.lng, n: 1, box: [r.lng, r.lat, r.lng, r.lat], members: [r] });
      else {
        c.n++;
        c.lat += r.lat;
        c.lng += r.lng;
        c.members.push(r);
        const b = c.box;
        if (r.lng < b[0]) b[0] = r.lng;
        if (r.lat < b[1]) b[1] = r.lat;
        if (r.lng > b[2]) b[2] = r.lng;
        if (r.lat > b[3]) b[3] = r.lat;
      }
    }
    if (cells.size <= MAX_CELLS || z <= 0) {
      for (const c of cells.values()) {
        c.lat /= c.n;
        c.lng /= c.n;
      }
      return [...cells.values()];
    }
  }
}
