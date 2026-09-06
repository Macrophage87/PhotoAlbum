"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type Tab = { href: string; label: string; exact?: boolean };

export function TripTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  return (
    <nav className="mx-auto max-w-6xl px-4 sm:px-6 mt-4 border-b border-border overflow-x-auto">
      <ul className="flex gap-1 -mb-px min-w-max">
        {tabs.map((t) => {
          const active = t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(t.href + "/");
          return (
            <li key={t.href}>
              <Link href={t.href} className={`inline-block px-3 py-2.5 text-sm border-b-2 transition-colors ${active ? "border-primary text-primary font-medium" : "border-transparent text-muted hover:text-text"}`}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
