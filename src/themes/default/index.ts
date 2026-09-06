import { PlaceholderArt } from "../PlaceholderArt";
import type { Theme } from "../types";

export const defaultTheme: Theme = {
  key: "default",
  name: "Classic",
  description: "Clean and neutral. Works for any trip.",
  palette: {
    bg: "#f8fafc",
    surface: "#ffffff",
    surfaceAlt: "#f1f5f9",
    text: "#0f172a",
    textMuted: "#64748b",
    primary: "#2563eb",
    primaryFg: "#ffffff",
    accent: "#0ea5e9",
    accentFg: "#ffffff",
    border: "#e2e8f0",
    ring: "#93c5fd",
  },
  fonts: { display: "var(--font-inter), system-ui, sans-serif", body: "var(--font-inter), system-ui, sans-serif" },
  radius: "0.75rem",
  headerArt: PlaceholderArt,
  map: { trackColor: "#2563eb", photoMarkerColor: "#2563eb", clusterColor: "#1d4ed8" },
  markerIcon:
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="#2563eb" stroke="#fff" stroke-width="3"/></svg>',
  swatch: ["#2563eb", "#0ea5e9", "#f8fafc"],
};
