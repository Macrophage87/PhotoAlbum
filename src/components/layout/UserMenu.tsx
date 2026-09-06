import Link from "next/link";
import type { Viewer } from "@/lib/auth/viewer";

export function UserMenu({ viewer }: { viewer: Viewer }) {
  if (viewer.kind !== "user") {
    return (
      <Link href="/auth/signin" className="ml-2 px-3 py-1.5 rounded-theme bg-primary text-primary-fg">
        Family sign in
      </Link>
    );
  }
  return (
    <form action="/auth/signout" method="post" className="ml-2 flex items-center gap-2">
      <span className="hidden sm:inline text-muted truncate max-w-[12rem]" title={viewer.user.email}>
        {viewer.user.name ?? viewer.user.email}
      </span>
      <button type="submit" className="px-3 py-1.5 rounded-theme border border-border hover:bg-surface-alt">
        Sign out
      </button>
    </form>
  );
}
