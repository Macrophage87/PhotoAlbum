import { cache } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Role } from "@/generated/prisma/enums";
import { readSessionUser } from "./session";

export type ViewerUser = { id: string; email: string; name: string | null; role: Role };

export type Viewer =
  | { kind: "user"; user: ViewerUser; shareTokens: Map<string, string> }
  | { kind: "anonymous"; user: null; shareTokens: Map<string, string> };

export const SHARE_COOKIE_PREFIX = "share_";

async function readShareCookies(): Promise<Map<string, string>> {
  const store = await cookies();
  const map = new Map<string, string>();
  for (const c of store.getAll()) {
    if (c.name.startsWith(SHARE_COOKIE_PREFIX)) map.set(c.name.slice(SHARE_COOKIE_PREFIX.length), c.value);
  }
  return map;
}

/** Who is looking: a signed-in member, or an anonymous visitor (possibly holding share cookies). Cached per request. */
export const getViewer = cache(async (): Promise<Viewer> => {
  const [user, shareTokens] = await Promise.all([readSessionUser(), readShareCookies()]);
  if (user) return { kind: "user", user: { id: user.id, email: user.email, name: user.name, role: user.role }, shareTokens };
  return { kind: "anonymous", user: null, shareTokens };
});

/** Redirects to sign-in when not a member. Use in pages that always need a member. */
export async function requireUser(nextPath?: string): Promise<ViewerUser> {
  const viewer = await getViewer();
  if (viewer.kind !== "user") {
    const q = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";
    redirect(`/auth/signin${q}`);
  }
  return viewer.user;
}

export async function requireAdmin(nextPath?: string): Promise<ViewerUser> {
  const user = await requireUser(nextPath);
  if (user.role !== "ADMIN") redirect("/");
  return user;
}

/** Throws instead of redirecting; for Server Actions and Route Handlers. */
export async function requireUserOrThrow(): Promise<ViewerUser> {
  const viewer = await getViewer();
  if (viewer.kind !== "user") throw new Error("Unauthorized");
  return viewer.user;
}

/** Throws instead of redirecting, for the Server Actions only an admin may run. */
export async function requireAdminOrThrow(): Promise<ViewerUser> {
  const user = await requireUserOrThrow();
  if (user.role !== "ADMIN") throw new Error("Admins only");
  return user;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
