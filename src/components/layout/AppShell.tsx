import type { ReactNode } from "react";
import { Nav } from "./Nav";
import type { Viewer } from "@/lib/auth/viewer";

export function AppShell({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav viewer={viewer} />
      <main className="flex-1">{children}</main>
    </div>
  );
}

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}
