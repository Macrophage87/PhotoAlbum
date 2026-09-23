"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavLink } from "./MobileNav";

/**
 * The links a member reaches for now and then, folded behind one button so the everyday ones fit across a laptop.
 *
 * A button and a list, the plainest menu there is: it opens on a click, Enter or Space; Escape or a click anywhere
 * else closes it and hands focus back to the button; and it closes itself once a link has taken you somewhere.
 */
export function MoreMenu({ links, account }: { links: NavLink[]; /** Who is signed in, shown at the head of the menu with the way to their account. */ account?: { label: string; title: string } | null }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!links.length && !account) return null;
  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="more-menu"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-theme hover:bg-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="nav-more"
      >
        More
        <span aria-hidden className={`text-[10px] transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <div ref={panel} id="more-menu" className="absolute right-0 top-full mt-1 min-w-48 rounded-theme border border-border bg-surface shadow-lg py-1 z-50">
          {account && (
            <>
              <Link href="/account" onClick={() => setOpen(false)} title={account.title} className="block px-3 py-2 hover:bg-surface-alt">
                <span className="block text-xs text-muted">Signed in as</span>
                <span className="block truncate max-w-[16rem]">{account.label}</span>
              </Link>
              <div className="my-1 border-t border-border" />
            </>
          )}
          <ul>
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={() => setOpen(false)}
                  aria-current={pathname === l.href ? "page" : undefined}
                  className={`block px-3 py-2 hover:bg-surface-alt ${pathname === l.href ? "font-medium text-primary" : ""}`}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
