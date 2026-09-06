import type { StyleSpecification } from "maplibre-gl";

const DEFAULT_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

/** A raster basemap style. Vector styles can be swapped in via NEXT_PUBLIC_MAP_STYLE_URL. */
export function basemapStyle(): string | StyleSpecification {
  const styleUrl = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
  if (styleUrl) return styleUrl;
  const tiles = process.env.NEXT_PUBLIC_TILE_URL || DEFAULT_TILES;
  return {
    version: 8,
    glyphs: process.env.NEXT_PUBLIC_MAP_GLYPHS_URL || DEFAULT_GLYPHS,
    sources: {
      basemap: { type: "raster", tiles: [tiles], tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    },
    layers: [{ id: "basemap", type: "raster", source: "basemap" }],
  };
}
