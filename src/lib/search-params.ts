/**
 * A query string as the object a page's `searchParams` is: one string per key, or every value when a key comes more
 * than once. `Object.fromEntries(sp.entries())` keeps only the last of a repeated key, so a gallery asked for two
 * people answered for one of them — on the next page, on the map, in the picker — and came back wider than the
 * page it continued.
 */
export function searchParamsObject(sp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}
