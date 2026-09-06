import type { ReactNode } from "react";
import { getTheme } from "./registry";
import { themeToCssVars } from "./css";

/** Scopes a theme's CSS variables to a subtree. Used by trip pages and share pages. */
export function TripTheme({ themeKey, children, className }: { themeKey: string; children: ReactNode; className?: string }) {
  const theme = getTheme(themeKey);
  return (
    <div data-theme={theme.key} style={themeToCssVars(theme)} className={className ?? "min-h-screen bg-bg text-text font-body"}>
      {children}
    </div>
  );
}
