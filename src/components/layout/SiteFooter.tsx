import Link from "next/link";

/**
 * The foot of every page: the way anybody looking at the album, family or not, can write to the family. The note
 * page records where they came from by itself (the Referer), so the link carries nothing.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border mt-auto">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 text-sm text-muted text-center">
        <Link href="/note" prefetch={false} className="underline underline-offset-2 hover:text-text" data-testid="footer-note">
          Send the family a note
        </Link>
      </div>
    </footer>
  );
}
