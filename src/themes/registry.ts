import { defaultTheme } from "./default";
import type { Theme } from "./types";

export const DEFAULT_THEME_KEY = "default";

const registry: Record<string, Theme> = {
  [defaultTheme.key]: defaultTheme,
};

/** Themes register themselves here; see src/themes/index.ts for the full list. */
export function registerTheme(theme: Theme) {
  registry[theme.key] = theme;
}

export function getTheme(key: string | null | undefined): Theme {
  return (key && registry[key]) || registry[DEFAULT_THEME_KEY];
}

export function listThemes(): Theme[] {
  return Object.values(registry);
}

export function isThemeKey(key: string): boolean {
  return key in registry;
}
