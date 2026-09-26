"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { TIMELINE_ORDER_COOKIE, type TimelineOrder } from "@/lib/timeline/order";

/** Kept for a year on this device, so the album opens the way this person likes to read it. */
function rememberOrder(value: TimelineOrder) {
  document.cookie = `${TIMELINE_ORDER_COOKIE}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/**
 * "Oldest first · Newest first". Each is an ordinary link to the same page the other way round, keeping whatever
 * search is in the address; choosing one also remembers it on this device for a year, so the album opens the way
 * this person likes to read it.
 */
export function OrderToggle({ order }: { order: TimelineOrder }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const href = (value: TimelineOrder) => {
    const next = new URLSearchParams(params.toString());
    next.set("order", value);
    return `${pathname}?${next.toString()}`;
  };
  const option = (value: TimelineOrder, label: string) => (
    <Link
      href={href(value)}
      onClick={() => rememberOrder(value)}
      aria-current={order === value ? "true" : undefined}
      data-testid={`timeline-order-${value}`}
      className={`px-2.5 py-1 rounded-theme ${order === value ? "bg-primary text-primary-fg" : "text-muted hover:text-text hover:bg-surface-alt"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Which way the timeline runs" className="inline-flex items-center gap-1 text-sm" data-testid="timeline-order">
      {option("oldest", "Oldest first")}
      {option("newest", "Newest first")}
    </nav>
  );
}
