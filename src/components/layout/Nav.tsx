import Link from "next/link";
import type { Viewer } from "@/lib/auth/viewer";
import { UserMenu } from "./UserMenu";
import { MobileNav } from "./MobileNav";

const memberLinks = [
  { href: "/", label: "Trips" },
  { href: "/timeline", label: "Timeline" },
  { href: "/map", label: "Map" },
  { href: "/upload", label: "Upload" },
];

export function Nav({ viewer }: { viewer: Viewer }) {
  const signedIn = viewer.kind === "user";
  const links = [
    ...(signedIn ? memberLinks : memberLinks.slice(0, 3)),
    ...(signedIn && viewer.user.role === "ADMIN" ? [{ href: "/admin", label: "Admin" }] : []),
  ];
  return (
    <header className="border-b border-border bg-surface/80 backdrop-blur sticky top-0 z-40">
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <Link href="/" className="font-display font-semibold text-lg tracking-tight whitespace-nowrap">
          Family Album
        </Link>
        <nav className="hidden sm:flex items-center gap-1 text-sm">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="px-3 py-1.5 rounded-theme hover:bg-surface-alt">
              {l.label}
            </Link>
          ))}
          <UserMenu viewer={viewer} />
        </nav>
        <MobileNav links={links} signedIn={signedIn} name={signedIn ? (viewer.user.name ?? viewer.user.email) : null} />
      </div>
    </header>
  );
}
