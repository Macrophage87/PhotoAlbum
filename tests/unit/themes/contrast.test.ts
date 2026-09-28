import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listThemes } from "@/themes/registry";

/** WCAG contrast ratio between two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("muted text in every theme", () => {
  // Muted chips and notes sit on surface-alt, the palest surface after the page: 4.5:1 is the floor for small text.
  it.each(listThemes().map((t) => [t.key, t.palette] as const))("is readable on every surface in %s", (_key, p) => {
    for (const bg of [p.bg, p.surface, p.surfaceAlt]) expect(contrast(p.textMuted, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("matches the default theme in the stylesheet pages outside a trip use", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain(`--th-text-muted: ${listThemes().find((t) => t.key === "default")!.palette.textMuted};`);
  });
});
