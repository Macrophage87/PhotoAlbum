"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Tells the album that this page was opened, once per page. Rendered on every page from the root layout.
 *
 * It is keyed to the path and nothing else, and the ref keeps a second run on the same path from counting twice —
 * which React does on purpose in development, and which the back button would otherwise do for real. `keepalive`
 * lets the note finish after the click that takes the reader onward.
 */
export function VisitBeacon() {
  const pathname = usePathname();
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (reported.current === pathname) return;
    reported.current = pathname;
    void fetch("/api/visit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: pathname, ref: document.referrer || null }),
      keepalive: true,
    }).catch(() => undefined);
  }, [pathname]);
  return null;
}
