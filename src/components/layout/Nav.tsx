import Link from "next/link";
import type { Viewer } from "@/lib/auth/viewer";
import { UserMenu } from "./UserMenu";

const memberLinks = [
  { href: "/", label: "Trips" },
  { href: "/timeline", label: "Timeline" },
  { href: "/map", label: "Map" },
  { href: "/upload", label: "Upload" },
];

export function Nav({ viewer }: { viewer: Viewer }) {
  return (
    <header className="border-b border-border bg-surface/80 backdrop-blur sticky top-0 z-40">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <Link href="/" className="font-display font-semibold text-lg tracking-tight">
          Family Album
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {(viewer.kind === "user" ? memberLinks : memberLinks.slice(0, 3)).map((l) => (
            <Link key={l.href} href={l.href} className="px-3 py-1.5 rounded-theme hover:bg-surface-alt">
              {l.label}
            </Link>
          ))}
          {viewer.kind === "user" && viewer.user.role === "ADMIN" && (
            <Link href="/admin" className="px-3 py-1.5 rounded-theme hover:bg-surface-alt">
              Admin
            </Link>
          )}
          <UserMenu viewer={viewer} />
        </nav>
      </div>
    </header>
  );
}
