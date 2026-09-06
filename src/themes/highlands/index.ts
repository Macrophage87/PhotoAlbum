import { PlaceholderArt } from "../PlaceholderArt";
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
  headerArt: PlaceholderArt,
  map: { trackColor: "#5e3a7a", photoMarkerColor: "#5e3a7a", clusterColor: "#3f2657", canvasFilter: "sepia(0.15) saturate(0.85)" },
  markerIcon:
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="#5e3a7a" stroke="#fff" stroke-width="3"/></svg>',
  swatch: ["#5e3a7a", "#4f7a3a", "#f5f3f7"],
};
