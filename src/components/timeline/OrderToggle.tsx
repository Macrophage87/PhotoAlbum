"use client";

import { SortToggle } from "@/components/ui/SortToggle";
import { TIMELINE_ORDER_COOKIE, type TimelineOrder } from "@/lib/timeline/order";

/** "Oldest first · Newest first" for a timeline, remembered on this device. */
export function OrderToggle({ order }: { order: TimelineOrder }) {
  return (
    <SortToggle
      value={order}
      options={[{ value: "oldest", label: "Oldest first" }, { value: "newest", label: "Newest first" }]}
      cookie={TIMELINE_ORDER_COOKIE}
      label="Which way the timeline runs"
      testId="timeline-order"
    />
  );
}
