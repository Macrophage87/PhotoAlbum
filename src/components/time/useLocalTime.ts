"use client";

import { useSyncExternalStore } from "react";
import { formatInstant, type InstantStyle } from "@/lib/time/format";

const noSubscription = () => () => {};

/**
 * A formatter for timestamps in the reader's own zone. The server renders these components in its zone, which the
 * browser does not share, so during server rendering and hydration they are written in UTC (and say so); once
 * hydrated they switch to the browser's zone. Without this the two disagree and React throws the tree away.
 */
export function useLocalTime(): (instant: string | Date, style?: InstantStyle) => string {
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  return (instant, style = "dateTime") => formatInstant(instant, style, hydrated ? undefined : "UTC");
}
