"use client";

import { useEffect, useState } from "react";
import { formatDay } from "@/lib/time/format";

export function DayJumpNav({ days }: { days: { key: string; id: string; count: number }[] }) {
  const [active, setActive] = useState<string | null>(days[0]?.id ?? null);
  useEffect(() => {
    const els = days.map((d) => document.getElementById(d.id)).filter((e): e is HTMLElement => Boolean(e));
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [days]);
  if (days.length < 2) return null;
  return (
    <nav className="hidden lg:block sticky top-20 self-start w-44 shrink-0">
      <ul className="space-y-1 text-sm border-l border-border">
        {days.map((d) => (
          <li key={d.id}>
            <a href={`#${d.id}`} className={`block pl-3 py-1 -ml-px border-l-2 transition-colors ${active === d.id ? "border-primary text-primary font-medium" : "border-transparent text-muted hover:text-text"}`}>
              {d.key === "undated" ? "Undated" : formatDay(d.key, "short")}
              <span className="ml-1 text-xs text-muted">{d.count}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
