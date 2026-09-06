import type { ComponentType } from "react";

export type ThemePalette = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryFg: string;
  accent: string;
  accentFg: string;
  border: string;
  ring: string;
};

export type Theme = {
  key: string;
  name: string;
  description: string;
  palette: ThemePalette;
  /** CSS font-family values (usually `var(--font-xxx), fallback`). */
  fonts: { display: string; body: string };
  radius: string;
  /** Full-width decorative header illustration. */
  headerArt: ComponentType<{ className?: string }>;
  /** Optional repeating SVG pattern (data URI) for dividers/section backgrounds. */
  motif?: { pattern: string; opacity: number };
  map: {
    trackColor: string;
    photoMarkerColor: string;
    clusterColor: string;
    /** CSS filter applied to the map canvas for a per-theme tint. */
    canvasFilter?: string;
    styleUrl?: string;
  };
  /** SVG markup for the photo marker icon (registered with MapLibre). */
  markerIcon: string;
  /** Swatch colours shown in the theme picker. */
  swatch: [string, string, string];
};
