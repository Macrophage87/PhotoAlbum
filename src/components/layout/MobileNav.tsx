"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavLink = { href: string; label: string };

/**
 * Collapsed navigation for narrow screens: a menu button that opens a panel of links.
 * The desktop link row is hidden below the `sm` breakpoint, and this component is hidden above it,
 * so each link exists exactly once at any viewport width.
 */
export function MobileNav({ links, signedIn, name }: { links: NavLink[]; signedIn: boolean; name?: string | null }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const close = () => setOpen(false);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? "Close menu" : "Open menu"}
        className="inline-flex h-10 w-10 items-center justify-center rounded-theme hover:bg-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {open ? (
            <path d="M6 6l12 12M18 6L6 18" />
          ) : (
            <path d="M4 7h16M4 12h16M4 17h16" />
          )}
        </svg>
      </button>
      {open && (
        <div id="mobile-nav-panel" className="absolute left-0 right-0 top-14 border-b border-border bg-surface shadow-lg">
          <nav className="mx-auto max-w-6xl px-4 py-2 flex flex-col text-base">
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={close} className={`px-3 py-2.5 rounded-theme hover:bg-surface-alt ${pathname === l.href ? "font-medium text-primary" : ""}`}>
                {l.label}
              </Link>
            ))}
            <div className="my-2 border-t border-border" />
            {signedIn ? (
              <form action="/auth/signout" method="post" className="flex items-center justify-between gap-3 px-3 py-2">
                {name && <span className="text-sm text-muted truncate">{name}</span>}
                <button type="submit" className="px-3 py-1.5 rounded-theme border border-border hover:bg-surface-alt text-sm">
                  Sign out
                </button>
              </form>
            ) : (
              <Link href="/auth/signin" onClick={close} className="mx-3 my-1 px-3 py-2 text-center rounded-theme bg-primary text-primary-fg">
                Family sign in
              </Link>
            )}
          </nav>
        </div>
      )}
    </div>
  );
}
