import { PlaceholderArt } from "../PlaceholderArt";
import type { Theme } from "../types";

export const swampTheme: Theme = {
  key: "swamp",
  name: "Swamp",
  description: "Deep greens, cypress brown and egret white for the Everglades.",
  palette: {
    bg: "#f3f5ef",
    surface: "#ffffff",
    surfaceAlt: "#e6ebdd",
    text: "#1c2a1e",
    textMuted: "#5c6b5e",
    primary: "#1f4d2e",
    primaryFg: "#ffffff",
    accent: "#e07a2f",
    accentFg: "#ffffff",
    border: "#d2dac8",
    ring: "#8fbf9a",
  },
  fonts: { display: "var(--font-fraunces), Georgia, serif", body: "var(--font-nunito), system-ui, sans-serif" },
  radius: "1rem",
  headerArt: PlaceholderArt,
  map: { trackColor: "#1f4d2e", photoMarkerColor: "#e07a2f", clusterColor: "#173a23", canvasFilter: "hue-rotate(-8deg) saturate(0.9)" },
  markerIcon:
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="#e07a2f" stroke="#fff" stroke-width="3"/></svg>',
  swatch: ["#1f4d2e", "#e07a2f", "#f3f5ef"],
};
