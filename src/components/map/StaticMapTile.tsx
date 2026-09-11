/**
 * A small map with no JavaScript: a 3×3 patch of raster tiles centred on a point, with a pin. Uses the same tile
 * template as the interactive map (NEXT_PUBLIC_TILE_URL, OpenStreetMap by default), so the CSP already allows it.
 */
const DEFAULT_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE = 256;

export function tileCoords(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function StaticMapTile({ lat, lng, zoom = 13, height = 160, className = "" }: { lat: number; lng: number; zoom?: number; height?: number; className?: string }) {
  const template = process.env.NEXT_PUBLIC_TILE_URL || DEFAULT_TILES;
  const { x, y } = tileCoords(lat, lng, zoom);
  const cx = Math.floor(x), cy = Math.floor(y);
  // Offset of the point inside the centre tile, so the 3×3 patch is shifted to put the point in the middle of the box.
  const dx = (x - cx) * TILE, dy = (y - cy) * TILE;
  const tiles: { u: string; left: number; top: number }[] = [];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const n = 2 ** zoom;
    const tx = ((cx + i) % n + n) % n, ty = cy + j;
    if (ty < 0 || ty >= n) continue;
    tiles.push({ u: template.replace("{z}", String(zoom)).replace("{x}", String(tx)).replace("{y}", String(ty)), left: i * TILE - dx, top: j * TILE - dy });
  }
  return (
    <div className={`relative overflow-hidden rounded-theme bg-surface-alt ${className}`} style={{ height }} role="img" aria-label={`Map around ${lat.toFixed(4)}, ${lng.toFixed(4)}`} data-testid="static-map">
      <div className="absolute left-1/2 top-1/2">
        {tiles.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={t.u} src={t.u} alt="" width={TILE} height={TILE} loading="lazy" className="absolute max-w-none" style={{ left: t.left, top: t.top }} />
        ))}
      </div>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full" aria-hidden="true">
        <svg width="22" height="30" viewBox="0 0 22 30"><path d="M11 0C4.9 0 0 4.9 0 11c0 8 11 19 11 19s11-11 11-19C22 4.9 17.1 0 11 0z" fill="var(--th-accent, #e07a2f)" stroke="#fff" strokeWidth="2" /><circle cx="11" cy="11" r="4" fill="#fff" /></svg>
      </div>
      <span className="absolute bottom-0 right-0 bg-white/80 text-[10px] text-black/70 px-1 rounded-tl">© OpenStreetMap</span>
    </div>
  );
}
