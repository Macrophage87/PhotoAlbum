"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** Kept for a year on this device, so a list opens the way this person likes to read it. */
function remember(cookie: string, value: string) {
  document.cookie = `${cookie}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/**
 * A row of ways to order a list — "Favorites first · Oldest first · Newest first". Each is an ordinary link to the
 * same page ordered that way, keeping whatever search is in the address and starting again from the first page;
 * choosing one also remembers it on this device under `cookie`.
 */
export function SortToggle<V extends string>({ value, options, cookie, label, testId, param = "order" }: {
  value: V;
  options: { value: V; label: string }[];
  cookie: string;
  /** What the choice is about, for screen readers: "Which way the timeline runs". */
  label: string;
  /** `${testId}-${option}` on each choice. */
  testId: string;
  param?: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const href = (v: V) => {
    const next = new URLSearchParams(params.toString());
    next.set(param, v);
    // A different order is a different list: page 3 of one is not page 3 of the other.
    next.delete("page");
    next.delete("cursor");
    return `${pathname}?${next.toString()}`;
  };
  return (
    <nav aria-label={label} className="inline-flex flex-wrap items-center gap-1 text-sm" data-testid={testId}>
      {options.map((o) => (
        <Link
          key={o.value}
          href={href(o.value)}
          onClick={() => remember(cookie, o.value)}
          aria-current={value === o.value ? "true" : undefined}
          data-testid={`${testId}-${o.value}`}
          className={`px-2.5 py-1 rounded-theme whitespace-nowrap ${value === o.value ? "bg-primary text-primary-fg" : "text-muted hover:text-text hover:bg-surface-alt"}`}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}
