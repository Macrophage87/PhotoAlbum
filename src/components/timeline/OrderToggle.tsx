"use client";

import { SortToggle } from "@/components/ui/SortToggle";
import { TIMELINE_ORDER_COOKIE, type TimelineOrder } from "@/lib/timeline/order";

/** "Newest first · Oldest first" for a timeline, remembered on this device (the same order as every sort switch). */
export function OrderToggle({ order }: { order: TimelineOrder }) {
  return (
    <SortToggle
      value={order}
      options={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]}
      cookie={TIMELINE_ORDER_COOKIE}
      label="Which way the timeline runs"
      testId="timeline-order"
    />
  );
}
