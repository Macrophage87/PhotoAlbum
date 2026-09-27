"use client";

import { useEffect, useState } from "react";
import { SHARE_OPENED_COOKIE } from "@/lib/share/opened-cookie";
import type { ShareKind } from "@/lib/auth/access";

/** Whether the browser kept the readable cookie set beside the share cookie, clearing it if so. */
function keptCookie(id: string): boolean {
  const kept = document.cookie.split("; ").includes(`${SHARE_OPENED_COOKIE}=${id}`);
  if (kept) document.cookie = `${SHARE_OPENED_COOKIE}=; path=/; max-age=0`;
  return kept;
}

/**
 * Cookies can't be set while rendering, so the first visit asks /api/share/open to set it and then loads the page
 * again. A real reload rather than router.refresh() (or a server action, which refreshes by itself): the page's
 * metadata streams into the body, and swapping this placeholder for the album in place leaves that first copy behind
 * beside the new one, two titles and two of every link-preview tag. It reloads only once the browser is seen to have
 * kept the cookie; if it did not (blocked cookies, private mode), or nothing answers, say so rather than reload or
 * spin forever.
 */
export function ShareCookie({ kind = "trip", id, token }: { kind?: ShareKind; id: string; token: string }) {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => !cancelled && setStuck(true), 4000);
    fetch("/api/share/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id, token }) })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`share cookie: ${res.status}`);
        clearTimeout(timer);
        if (keptCookie(id)) window.location.reload();
        else setStuck(true);
      })
      .catch(() => !cancelled && setStuck(true));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [kind, id, token]);
  if (!stuck) return null;
  return (
    <p className="mx-auto max-w-md text-center text-sm text-muted p-4" role="alert">
      This shared album needs cookies to show its photos. Enable cookies for this site (or leave private browsing) and reload the page.
    </p>
  );
}
