import Link from "next/link";
import type { Viewer } from "@/lib/auth/viewer";
import { UserMenu } from "./UserMenu";
import { MobileNav, type NavLink } from "./MobileNav";
import { MoreMenu } from "./MoreMenu";
import { SearchBox } from "@/components/search/SearchBox";

/** What a member uses every visit: always in the bar. */
const everyday: NavLink[] = [
  { href: "/", label: "Trips" },
  { href: "/timeline", label: "Timeline" },
  { href: "/map", label: "Map" },
  { href: "/favorites", label: "Favorites" },
  { href: "/upload", label: "Upload" },
  { href: "/people", label: "People" },
];

/** What a member reaches for now and then: behind "More" on a laptop, listed with the rest on a phone. */
const occasional: NavLink[] = [
  { href: "/review", label: "Review" },
  { href: "/graph", label: "Graph" },
];

/**
 * The bar across the top of every page.
 *
 * An admin has fifteen places to go, and a laptop has room for about half of them beside a search box, so the bar
 * shows the everyday ones, the family's guide and Sign out, and folds the rest — and who is signed in — behind
 * "More". Below a laptop's width the whole lot goes into the menu button instead, as it always has on a phone.
 * Help stays in the bar at every width: it is the page for whoever is least sure what anything else does.
 */
export function Nav({ viewer }: { viewer: Viewer }) {
  const signedIn = viewer.kind === "user";
  const admin = signedIn && viewer.user.role === "ADMIN";
  const help: NavLink = { href: "/guide", label: "Help" };
  // Visitors see what a public trip can show them; everything else needs a family member's sign-in.
  const inBar: NavLink[] = signedIn ? everyday : everyday.slice(0, 3);
  const adminLink: NavLink[] = admin ? [{ href: "/admin", label: "Admin" }] : [];
  const privacy: NavLink[] = signedIn ? [{ href: "/privacy", label: "Privacy" }] : [];
  // Search is here as well as in its box, which only fits beside the links on a wide screen.
  const inMore: NavLink[] = signedIn ? [{ href: "/search", label: "Search" }, ...occasional, ...adminLink, ...privacy] : [];
  // The phone's menu has room for everything, search included.
  const all: NavLink[] = [...inBar, ...(signedIn ? occasional : []), { href: "/search", label: "Search" }, ...adminLink, ...privacy, help];

  return (
    <header className="border-b border-border bg-surface/80 backdrop-blur sticky top-0 z-40">
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <Link href="/" className="font-display font-semibold text-lg tracking-tight whitespace-nowrap">
          Family Album
        </Link>
        <nav className="hidden lg:flex items-center gap-0.5 text-sm min-w-0" aria-label="Main">
          <SearchBox className="hidden xl:block w-44 mr-1" />
          {[...inBar, help].map((l) => (
            <Link key={l.href} href={l.href} className="px-2.5 py-1.5 rounded-theme hover:bg-surface-alt whitespace-nowrap">
              {l.label}
            </Link>
          ))}
          {signedIn && <MoreMenu links={inMore} account={{ label: viewer.user.name ?? viewer.user.email, title: `${viewer.user.email} · your account` }} />}
          <UserMenu viewer={viewer} />
        </nav>
        <MobileNav links={all} signedIn={signedIn} name={signedIn ? (viewer.user.name ?? viewer.user.email) : null} />
      </div>
    </header>
  );
}
