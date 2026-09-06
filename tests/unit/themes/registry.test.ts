import { describe, expect, it } from "vitest";
import { getTheme, isThemeKey, listThemes, themeToCssVars } from "@/themes";

const HEX = /^#[0-9a-f]{6}$/i;

describe("theme registry", () => {
  it("ships the six built-in themes with unique keys", () => {
    const keys = listThemes().map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["default", "lighthouse", "highlands", "swamp", "desert", "alpine"]));
  });
  it("every theme is complete", () => {
    for (const t of listThemes()) {
      for (const [k, v] of Object.entries(t.palette)) expect(v, `${t.key}.${k}`).toMatch(HEX);
      expect(t.fonts.display).toContain("var(--font-");
      expect(t.fonts.body).toContain("var(--font-");
      expect(typeof t.headerArt).toBe("function");
      expect(t.markerIcon).toMatch(/^<svg/);
      expect(t.swatch).toHaveLength(3);
      expect(t.map.trackColor).toMatch(HEX);
    }
  });
  it("falls back to the default theme for unknown keys", () => {
    expect(getTheme("nope").key).toBe("default");
    expect(getTheme(null).key).toBe("default");
    expect(isThemeKey("swamp")).toBe(true);
    expect(isThemeKey("Swamp")).toBe(false);
  });
  it("produces CSS variables", () => {
    const vars = themeToCssVars(getTheme("lighthouse")) as Record<string, string>;
    expect(vars["--th-primary"]).toBe("#14213d");
    expect(vars["--th-font-display"]).toContain("playfair");
  });
});
