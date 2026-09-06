import type { Theme } from "@/themes";

/** Serialisable slice of a theme that the client map needs. */
export type MapTheme = { trackColor: string; photoMarkerColor: string; clusterColor: string; canvasFilter?: string; styleUrl?: string; markerIcon: string };

export function mapThemeOf(theme: Theme): MapTheme {
  return { ...theme.map, markerIcon: theme.markerIcon };
}
