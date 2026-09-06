"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { setShareCookie } from "./actions";

/**
 * Cookies can't be set while rendering, so the first visit sets it via an action and refreshes.
 * This component stays mounted across the refresh; if it is still showing a few seconds later the
 * cookie was not accepted (blocked cookies, private mode), so say so rather than spin forever.
 */
export function ShareCookie({ tripId, token }: { tripId: string; token: string }) {
  const router = useRouter();
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setShareCookie(tripId, token)
      .then(() => router.refresh())
      .catch(() => setStuck(true));
    const timer = setTimeout(() => !cancelled && setStuck(true), 4000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tripId, token, router]);
  if (!stuck) return null;
  return (
    <p className="mx-auto max-w-md text-center text-sm text-muted p-4" role="alert">
      This shared album needs cookies to show its photos. Enable cookies for this site (or leave private browsing) and reload the page.
    </p>
  );
}
