import Link from "next/link";
import type { Viewer } from "@/lib/auth/viewer";
import { UserMenu } from "./UserMenu";
import { MobileNav, type NavLink } from "./MobileNav";
import { SearchBox } from "@/components/search/SearchBox";

const memberLinks = [
  { href: "/", label: "Trips" },
  { href: "/timeline", label: "Timeline" },
  { href: "/map", label: "Map" },
  { href: "/favorites", label: "Favorites" },
  { href: "/upload", label: "Upload" },
  { href: "/review", label: "Review" },
  { href: "/people", label: "People" },
  { href: "/graph", label: "Graph" },
];

export function Nav({ viewer }: { viewer: Viewer }) {
  const signedIn = viewer.kind === "user";
  const links: NavLink[] = [
    ...(signedIn ? memberLinks : memberLinks.slice(0, 3)),
    { href: "/search", label: "Search" },
    ...(signedIn && viewer.user.role === "ADMIN" ? [{ href: "/admin", label: "Admin" }] : []),
    ...(signedIn ? [{ href: "/privacy", label: "Privacy" }] : []),
    // The family's own guide to the album, written for whoever is least sure about computers. Open to anyone who
    // reaches the site: its first section is how to sign in, and whoever needs that is not signed in.
    { href: "/guide", label: "Help" },
  ];
  return (
    <header className="border-b border-border bg-surface/80 backdrop-blur sticky top-0 z-40">
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <Link href="/" className="font-display font-semibold text-lg tracking-tight whitespace-nowrap">
          Family Album
        </Link>
        <nav className="hidden sm:flex items-center gap-1 text-sm">
          <SearchBox className="hidden md:block w-44 lg:w-56 mr-1" />
          {links.filter((l) => l.href !== "/search").map((l) => (
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
