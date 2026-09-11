import { KennelArt, kennelMarker, kennelMotif } from "../art/KennelArt";
import type { Theme } from "../types";

/** For the dog: warm fur browns, meadow green, a tennis-ball accent, and paw prints for the motif and marker. */
export const kennelTheme: Theme = {
  key: "kennel",
  name: "Dog Park",
  description: "Warm browns, meadow green and a tennis-ball yellow for collections about the dog.",
  palette: {
    bg: "#fbf7f0",
    surface: "#ffffff",
    surfaceAlt: "#f1e8da",
    text: "#2b1d12",
    textMuted: "#6f5b48",
    primary: "#8a5a2b",
    primaryFg: "#ffffff",
    accent: "#b7c92f",
    accentFg: "#1f2a0a",
    border: "#e3d5c0",
    ring: "#d2a36c",
  },
  fonts: { display: "var(--font-fraunces), Georgia, serif", body: "var(--font-nunito), system-ui, sans-serif" },
  radius: "1.25rem",
  headerArt: KennelArt,
  map: { trackColor: "#8a5a2b", photoMarkerColor: "#b7c92f", clusterColor: "#6b4a2b", canvasFilter: "sepia(0.12) saturate(1.05)" },
  markerIcon: kennelMarker,
  motif: { pattern: kennelMotif, opacity: 0.3 },
  swatch: ["#8a5a2b", "#b7c92f", "#fbf7f0"],
};
