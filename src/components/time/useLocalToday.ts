"use client";

import { useSyncExternalStore } from "react";
import { localToday, type LocalDay } from "@/lib/time/local-day";

const noSubscription = () => () => {};

/**
 * Today's date on the reader's own clock, for a date field's default. The server does not know the reader's zone
 * (its day is the UTC one, tomorrow on an American evening), so during server rendering and hydration this is
 * blank, and once hydrated it is the browser's day. Without that the two would disagree and React would throw the
 * tree away.
 */
export function useLocalToday(): LocalDay | "" {
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  return hydrated ? localToday() : "";
}
