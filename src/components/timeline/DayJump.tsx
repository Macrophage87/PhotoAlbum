"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatDay } from "@/lib/time/format";
import { monthsOf, type NavDay } from "./TimelineNav";

/**
 * The day heading on a timeline, and on a phone the way to a different day.
 *
 * The heading sticks to the top of the page as you scroll, so it is always the answer to "what am I looking at".
 * There is no room beside the path on a phone for the panel that holds the whole timeline, and a control above the
 * path scrolls away the moment you use the timeline at all — but the heading is always there. So pressing it opens
 * every day the album holds, gathered by month, to choose from.
 *
 * The sheet is put at the foot of the document rather than inside the heading: the heading is sticky and blurs what
 * passes behind it, and an ancestor that does that becomes what `fixed` inside it is measured against, which would
 * pin the sheet to the heading instead of to the screen.
 */
export function DayJump({ days, current, label }: { days: NavDay[]; current: string; label: string }) {
  const [open, setOpen] = useState(false);
  const months = useMemo(() => monthsOf(days), [days]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", esc);
    // Nothing behind the sheet should scroll under it.
    const had = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = had;
    };
  }, [open]);

  // One day is not a timeline to navigate, and beside a wide enough path the panel is already there.
  if (days.length < 2) return <span>{label}</span>;

  const go = (id: string) => {
    setOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <span className="hidden lg:inline">{label}</span>
      <button
        type="button"
        data-testid="day-jump"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="lg:hidden inline-flex items-baseline gap-1.5 text-left underline decoration-border decoration-2 underline-offset-4 hover:decoration-primary"
      >
        <span>{label}</span>
        <span aria-hidden className="text-xs text-muted">▾</span>
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Go to a day">
            <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
            <div data-testid="day-jump-sheet" className="relative max-h-[70vh] overflow-y-auto rounded-t-theme border-t border-border bg-surface font-body text-base font-normal shadow-lg">
              <div className="sticky top-0 flex items-baseline justify-between gap-3 border-b border-border bg-surface px-4 py-3">
                <p className="font-display text-lg font-semibold">Go to a day</p>
                <button type="button" className="text-sm text-muted hover:text-text" onClick={() => setOpen(false)}>Close</button>
              </div>
              <div className="p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                {months.map((m) => (
                  <div key={m.key} className="mb-3 last:mb-0">
                    <p className="px-2 py-1 text-xs uppercase tracking-wide text-muted">{m.label}</p>
                    <ul>
                      {m.days.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            data-day-jump={d.id}
                            onClick={() => go(d.id)}
                            aria-current={d.id === current ? "true" : undefined}
                            className={`flex w-full items-baseline gap-2 rounded-theme px-2 py-2.5 text-left ${d.id === current ? "bg-surface-alt text-primary font-medium" : "hover:bg-surface-alt"}`}
                          >
                            <span className="flex-1 truncate">{d.key === "undated" ? "No date" : formatDay(d.key, "shortDay")}</span>
                            <span className="text-sm text-muted">{d.count} photo{d.count === 1 ? "" : "s"}</span>
                          </button>
                          {d.activities?.map((a) => (
                            <button
                              key={a.id}
                              type="button"
                              data-activity-jump={a.id}
                              onClick={() => go(a.id)}
                              className="flex w-full items-baseline gap-2 rounded-theme py-1.5 pl-6 pr-2 text-left text-sm text-muted hover:bg-surface-alt hover:text-text"
                            >
                              <span className="flex-1 truncate">{a.title}</span>
                              <span>{a.count}</span>
                            </button>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
