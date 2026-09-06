import { listThemes } from "@/themes";

export function ThemePicker({ name = "themeKey", value }: { name?: string; value: string }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {listThemes().map((t) => (
        <label key={t.key} className="cursor-pointer rounded-theme border border-border p-3 has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-ring">
          <input type="radio" name={name} value={t.key} defaultChecked={t.key === value} className="sr-only" />
          <div className="flex gap-1 mb-2">
            {t.swatch.map((c, i) => (
              <span key={i} className="h-5 flex-1 rounded" style={{ background: c }} />
            ))}
          </div>
          <div className="font-medium text-sm" style={{ fontFamily: t.fonts.display }}>
            {t.name}
          </div>
          <div className="text-xs text-muted">{t.description}</div>
        </label>
      ))}
    </div>
  );
}
