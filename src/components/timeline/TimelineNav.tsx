"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDay } from "@/lib/time/format";

export type NavDay = { key: string; id: string; count: number };

/** Days gathered under the month they fall in; undated photographs sit at the end under their own heading. */
export type NavMonth = { key: string; label: string; days: NavDay[]; count: number };

/** "2025-08-14" → "2025-08"; the undated group keeps its own key so it sorts and labels itself. */
export function monthsOf(days: NavDay[]): NavMonth[] {
  const out: NavMonth[] = [];
  const years = new Set(days.filter((d) => d.key !== "undated").map((d) => d.key.slice(0, 4)));
  for (const day of days) {
    const key = day.key === "undated" ? "undated" : day.key.slice(0, 7);
    let month = out[out.length - 1];
    if (!month || month.key !== key) {
      // The year is worth repeating only where it tells you something: an album that spans more than one.
      const label = key === "undated" ? "No date" : monthLabel(key, years.size > 1);
      month = { key, label, days: [], count: 0 };
      out.push(month);
    }
    month.days.push(day);
    month.count += day.count;
  }
  return out;
}

function monthLabel(key: string, withYear: boolean): string {
  const [year, month] = key.split("-");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const name = names[Number(month) - 1] ?? key;
  return withYear ? `${name} ${year}` : name;
}

/**
 * The panel down the left of the timeline's path: the whole thing at a glance, and a way to any part of it.
 *
 * A family timeline is not a list you page through, it is a place you go back to — "the morning we got the puppy",
 * "that Christmas" — so what the panel shows is every day the album holds, gathered by month, with how much is in
 * each, and the day you are looking at marked as you scroll. Months fold away so a long album stays a list you can
 * run your eye down, and the month you are in unfolds itself.
 */
export function TimelineNav({ days, idPrefix }: { days: NavDay[]; idPrefix: string }) {
  const months = useMemo(() => monthsOf(days), [days]);
  const [active, setActive] = useState<string | null>(days[0]?.id ?? null);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const panel = useRef<HTMLElement>(null);

  /**
   * Which day is under the reader's eye: the last one to have passed a line a quarter of the way down the page.
   *
   * The end of a page cannot be scrolled past, so the final day never reaches that line however far you scroll —
   * which left the panel pointing at the middle of an album while you looked at the end of it. So once the page
   * has run out, the last day still on screen is taken as the one being read.
   */
  useEffect(() => {
    const els = days.map((d) => document.getElementById(d.id)).filter((e): e is HTMLElement => Boolean(e));
    if (!els.length) return;
    let frame = 0;
    const pick = () => {
      frame = 0;
      const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      const line = window.innerHeight * 0.25;
      let best = els[0];
      if (atEnd) {
        for (const e of els) if (e.getBoundingClientRect().top < window.innerHeight) best = e;
      } else {
        for (const e of els) if (e.getBoundingClientRect().top <= line) best = e;
      }
      setActive(best.id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(pick);
    };
    pick();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [days]);

  // Follow the reader down the panel, without dragging the page about: only the panel's own scroll moves.
  useEffect(() => {
    if (!active || !panel.current) return;
    const here = panel.current.querySelector<HTMLElement>(`[data-day="${active}"]`);
    if (!here) return;
    const box = panel.current.getBoundingClientRect();
    const mine = here.getBoundingClientRect();
    if (mine.top < box.top || mine.bottom > box.bottom) panel.current.scrollTop += mine.top - box.top - box.height / 3;
  }, [active]);

  if (days.length < 2) return null;
  const total = days.reduce((n, d) => n + d.count, 0);
  const activeMonth = months.find((m) => m.days.some((d) => d.id === active))?.key;

  return (
    <>
      {/* Narrow screens have no room beside the path, so the same list becomes one control above it. */}
      <div className="lg:hidden mb-4">
        <label className="text-xs text-muted" htmlFor={`${idPrefix}-jump`}>Jump to</label>
        <select
          id={`${idPrefix}-jump`}
          className="mt-1 h-9 w-full rounded-theme border border-border bg-surface px-2 text-sm"
          value={active ?? ""}
          onChange={(e) => {
            setActive(e.target.value);
            document.getElementById(e.target.value)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {months.map((m) => (
            <optgroup key={m.key} label={m.label}>
              {m.days.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.key === "undated" ? "No date" : formatDay(d.key, "short")} · {d.count}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <nav ref={panel} aria-label="The whole timeline" data-testid="timeline-nav" className="hidden lg:block sticky top-20 self-start w-56 shrink-0 max-h-[calc(100vh-7rem)] overflow-y-auto pr-1">
        <p className="text-xs text-muted mb-2">
          {total} photo{total === 1 ? "" : "s"} over {days.filter((d) => d.key !== "undated").length} day
          {days.filter((d) => d.key !== "undated").length === 1 ? "" : "s"}
        </p>
        <ul className="space-y-2 text-sm">
          {months.map((m) => {
            const open = !shut.has(m.key) || m.key === activeMonth;
            return (
              <li key={m.key}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setShut((s) => { const next = new Set(s); if (next.has(m.key)) next.delete(m.key); else next.add(m.key); return next; })}
                  className={`flex w-full items-baseline gap-1.5 text-left font-medium ${m.key === activeMonth ? "text-text" : "text-muted hover:text-text"}`}
                >
                  <span aria-hidden className={`text-[10px] transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
                  <span className="flex-1 truncate">{m.label}</span>
                  <span className="text-xs text-muted">{m.count}</span>
                </button>
                {open && (
                  <ul className="mt-1 border-l border-border">
                    {m.days.map((d) => (
                      <li key={d.id}>
                        <a
                          href={`#${d.id}`}
                          data-day={d.id}
                          onClick={() => setActive(d.id)}
                          aria-current={active === d.id ? "true" : undefined}
                          className={`flex items-baseline gap-1.5 pl-3 py-1 -ml-px border-l-2 transition-colors ${active === d.id ? "border-primary text-primary font-medium" : "border-transparent text-muted hover:text-text"}`}
                        >
                          <span className="flex-1 truncate">{d.key === "undated" ? "No date" : formatDay(d.key, "short")}</span>
                          <span className="text-xs text-muted">{d.count}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
