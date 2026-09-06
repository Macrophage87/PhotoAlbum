import { PlaceholderArt } from "../PlaceholderArt";
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
  headerArt: PlaceholderArt,
  map: { trackColor: "#c1272d", photoMarkerColor: "#14213d", clusterColor: "#0b3d91", canvasFilter: "saturate(0.85) contrast(1.02)" },
  markerIcon:
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="#14213d" stroke="#fff" stroke-width="3"/></svg>',
  swatch: ["#14213d", "#c1272d", "#f4f6f8"],
};
