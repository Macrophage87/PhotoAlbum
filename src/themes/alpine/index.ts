import { AlpineArt, alpineMarker, alpineMotif } from "../art/AlpineArt";
import type { Theme } from "../types";

export const alpineTheme: Theme = {
  key: "alpine",
  name: "Alpine",
  description: "Ice blue, granite and pine for mountains and snowlines.",
  palette: {
    bg: "#f3f7fa",
    surface: "#ffffff",
    surfaceAlt: "#e6eef4",
    text: "#1b2733",
    textMuted: "#5d6d7b",
    primary: "#1f5f8b",
    primaryFg: "#ffffff",
    accent: "#2f6b3a",
    accentFg: "#ffffff",
    border: "#d3dfe8",
    ring: "#8fc0e0",
  },
  fonts: { display: "var(--font-montserrat), system-ui, sans-serif", body: "var(--font-open-sans), system-ui, sans-serif" },
  radius: "0.5rem",
  headerArt: AlpineArt,
  map: { trackColor: "#1f5f8b", photoMarkerColor: "#1f5f8b", clusterColor: "#154466", canvasFilter: "saturate(0.9) brightness(1.02)" },
  markerIcon: alpineMarker,
  motif: { pattern: alpineMotif, opacity: 0.35 },
  swatch: ["#1f5f8b", "#2f6b3a", "#f3f7fa"],
};
