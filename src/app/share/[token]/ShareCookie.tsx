"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { setShareCookie } from "./actions";

/** Cookies can't be set while rendering, so the first visit sets it via an action and refreshes. */
export function ShareCookie({ tripId, token }: { tripId: string; token: string }) {
  const router = useRouter();
  useEffect(() => {
    setShareCookie(tripId, token).then(() => router.refresh());
  }, [tripId, token, router]);
  return null;
}
