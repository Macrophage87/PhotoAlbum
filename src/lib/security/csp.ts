/**
 * The nonce-based Content Security Policy, as a pure function so the directives are unit-tested.
 * Hosts come from the map configuration: tiles, style and glyphs may live on outside providers.
 */
export type CspInput = { nonce: string; dev: boolean; tileUrl?: string; styleUrl?: string; glyphsUrl?: string };

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.replace(/\{[^}]*\}/g, "x")).origin;
  } catch {
    return null;
  }
}

export const DEFAULT_TILE_ORIGIN = "https://tile.openstreetmap.org";
export const DEFAULT_GLYPH_ORIGIN = "https://demotiles.maplibre.org";

export function buildCsp(input: CspInput): string {
  const mapHosts = [...new Set([originOf(input.tileUrl) ?? DEFAULT_TILE_ORIGIN, originOf(input.styleUrl), originOf(input.glyphsUrl) ?? DEFAULT_GLYPH_ORIGIN].filter(Boolean) as string[])];
  const script = [`'self'`, `'nonce-${input.nonce}'`, `'strict-dynamic'`, ...(input.dev ? [`'unsafe-eval'`] : [])].join(" ");
  return [
    `default-src 'self'`,
    `script-src ${script}`,
    // TripTheme and charts set style attributes; MapLibre injects a stylesheet.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${mapHosts.join(" ")}`,
    `media-src 'self' blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${mapHosts.join(" ")}`,
    // MapLibre's worker is served from /maplibre; Sigma and uPlot draw on canvases.
    `worker-src 'self' blob:`,
    `frame-src https://www.youtube-nocookie.com`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `manifest-src 'self'`,
  ].join("; ");
}

export const CSP_HEADER = "Content-Security-Policy";
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
