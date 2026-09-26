import type { Viewer } from "@/lib/auth/viewer";
import { SignInLink } from "./SignInLink";

export function UserMenu({ viewer }: { viewer: Viewer }) {
  if (viewer.kind !== "user") {
    return <SignInLink className="ml-2 px-3 py-1.5 rounded-theme bg-primary text-primary-fg whitespace-nowrap" />;
  }
  return (
    // Who is signed in, and the way to their account, are at the head of the "More" menu beside this.
    <form action="/auth/signout" method="post" className="ml-2 flex items-center gap-2">
      <button type="submit" className="px-3 py-1.5 rounded-theme border border-border hover:bg-surface-alt whitespace-nowrap">
        Sign out
      </button>
    </form>
  );
}
