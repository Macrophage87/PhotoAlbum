import { PlaceholderArt } from "../PlaceholderArt";
import type { Theme } from "../types";

export const desertTheme: Theme = {
  key: "desert",
  name: "Desert Canyon",
  description: "Terracotta, sandstone and sage under a turquoise sky.",
  palette: {
    bg: "#faf5ef",
    surface: "#fffdf9",
    surfaceAlt: "#f2e8dc",
    text: "#3b2a1e",
    textMuted: "#7d6a5a",
    primary: "#b5542a",
    primaryFg: "#ffffff",
    accent: "#2aa1a8",
    accentFg: "#ffffff",
    border: "#e5d8c8",
    ring: "#e3a37f",
  },
  fonts: { display: "var(--font-bitter), Georgia, serif", body: "var(--font-work-sans), system-ui, sans-serif" },
  radius: "0.5rem",
  headerArt: PlaceholderArt,
  map: { trackColor: "#b5542a", photoMarkerColor: "#b5542a", clusterColor: "#8a3d1c", canvasFilter: "sepia(0.25) saturate(0.9)" },
  markerIcon:
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="#b5542a" stroke="#fff" stroke-width="3"/></svg>',
  swatch: ["#b5542a", "#2aa1a8", "#faf5ef"],
};
