import { defaultTheme } from "./default";
import { lighthouseTheme } from "./lighthouse";
import { highlandsTheme } from "./highlands";
import { swampTheme } from "./swamp";
import { desertTheme } from "./desert";
import { alpineTheme } from "./alpine";
import { kennelTheme } from "./kennel";
import type { Theme } from "./types";

export const DEFAULT_THEME_KEY = "default";

const registry: Record<string, Theme> = Object.fromEntries(
  [defaultTheme, lighthouseTheme, highlandsTheme, swampTheme, desertTheme, alpineTheme, kennelTheme].map((t) => [t.key, t]),
);

export function getTheme(key: string | null | undefined): Theme {
  return (key && registry[key]) || registry[DEFAULT_THEME_KEY];
}

export function listThemes(): Theme[] {
  return Object.values(registry);
}

export function isThemeKey(key: string): boolean {
  return key in registry;
}
