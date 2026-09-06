import { HighlandsArt, highlandsMarker, highlandsMotif } from "../art/HighlandsArt";
import type { Theme } from "../types";

export const highlandsTheme: Theme = {
  key: "highlands",
  name: "Highlands",
  description: "Heather, peat and moss for misty hills and castles.",
  palette: {
    bg: "#f5f3f7",
    surface: "#fdfcfe",
    surfaceAlt: "#ebe6f0",
    text: "#2b1d33",
    textMuted: "#6f6279",
    primary: "#5e3a7a",
    primaryFg: "#ffffff",
    accent: "#4f7a3a",
    accentFg: "#ffffff",
    border: "#dcd4e3",
    ring: "#b79cd0",
  },
  fonts: { display: "var(--font-cormorant), Georgia, serif", body: "var(--font-lato), system-ui, sans-serif" },
  radius: "0.5rem",
  headerArt: HighlandsArt,
  map: { trackColor: "#5e3a7a", photoMarkerColor: "#5e3a7a", clusterColor: "#3f2657", canvasFilter: "sepia(0.15) saturate(0.85)" },
  markerIcon: highlandsMarker,
  motif: { pattern: highlandsMotif, opacity: 0.35 },
  swatch: ["#5e3a7a", "#4f7a3a", "#f5f3f7"],
};
