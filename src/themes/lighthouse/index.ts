import { LighthouseArt, lighthouseMarker, lighthouseMotif } from "../art/LighthouseArt";
import type { Theme } from "../types";

export const lighthouseTheme: Theme = {
  key: "lighthouse",
  name: "Lighthouse Coast",
  description: "Navy, fog and red-and-white stripes for rocky coastlines.",
  palette: {
    bg: "#f4f6f8",
    surface: "#ffffff",
    surfaceAlt: "#e9eef3",
    text: "#14213d",
    textMuted: "#5b6b7f",
    primary: "#14213d",
    primaryFg: "#ffffff",
    accent: "#c1272d",
    accentFg: "#ffffff",
    border: "#d5dde6",
    ring: "#8fb3d9",
  },
  fonts: { display: "var(--font-playfair), Georgia, serif", body: "var(--font-source-sans), system-ui, sans-serif" },
  radius: "0.375rem",
  headerArt: LighthouseArt,
  map: { trackColor: "#c1272d", photoMarkerColor: "#14213d", clusterColor: "#0b3d91", canvasFilter: "saturate(0.85) contrast(1.02)" },
  markerIcon: lighthouseMarker,
  motif: { pattern: lighthouseMotif, opacity: 0.35 },
  swatch: ["#14213d", "#c1272d", "#f4f6f8"],
};
