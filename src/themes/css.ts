import type { CSSProperties } from "react";
import type { Theme } from "./types";

/** Turns a theme into the CSS custom properties consumed by globals.css. */
export function themeToCssVars(theme: Theme): CSSProperties {
  const p = theme.palette;
  return {
    "--th-bg": p.bg,
    "--th-surface": p.surface,
    "--th-surface-alt": p.surfaceAlt,
    "--th-text": p.text,
    "--th-text-muted": p.textMuted,
    "--th-primary": p.primary,
    "--th-primary-fg": p.primaryFg,
    "--th-accent": p.accent,
    "--th-accent-fg": p.accentFg,
    "--th-border": p.border,
    "--th-ring": p.ring,
    "--th-font-display": theme.fonts.display,
    "--th-font-body": theme.fonts.body,
    "--th-radius": theme.radius,
  } as CSSProperties;
}
