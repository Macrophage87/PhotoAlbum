"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Whether the header should offer "Family sign in": not on the sign-in pages themselves, where it only distracts. */
export function offersSignIn(pathname: string | null): boolean {
  return !pathname || !/^\/auth(\/|$)/.test(pathname);
}

export function SignInLink({ className, onClick }: { className: string; onClick?: () => void }) {
  if (!offersSignIn(usePathname())) return null;
  return (
    <Link href="/auth/signin" onClick={onClick} className={className}>
      Family sign in
    </Link>
  );
}
