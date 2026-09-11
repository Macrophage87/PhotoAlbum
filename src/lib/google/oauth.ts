import { env } from "@/lib/env";

export const PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

export function googleConfigured(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_OAUTH_CLIENT_ID && e.GOOGLE_OAUTH_CLIENT_SECRET && e.TOKEN_ENCRYPTION_KEY);
}

export function redirectUri(): string {
  return new URL("/api/google/callback", env().APP_URL).toString();
}

/** The consent URL: offline access with a forced consent screen so a refresh token is always returned. */
export function authorizationUrl(state: string): string {
  // Joined as strings: a base with a path (a test double) must keep it, which `new URL("/x", base)` would drop.
  const u = new URL(`${env().GOOGLE_ACCOUNTS_URL.replace(/\/$/, "")}/o/oauth2/v2/auth`);
  u.searchParams.set("client_id", env().GOOGLE_OAUTH_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", PICKER_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  return u.toString();
}

export class GoogleAuthError extends Error {
  constructor(message: string, public readonly needsReconnect: boolean) {
    super(message);
  }
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; scope?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const e = env();
  const res = await fetch(`${e.GOOGLE_OAUTH_BASE_URL.replace(/\/$/, "")}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: e.GOOGLE_OAUTH_CLIENT_ID ?? "", client_secret: e.GOOGLE_OAUTH_CLIENT_SECRET ?? "", ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    // invalid_grant: the refresh token was revoked or expired; the member has to connect again.
    throw new GoogleAuthError(body.error_description ?? body.error ?? `Google token request failed (${res.status})`, body.error === "invalid_grant");
  }
  return body;
}

export async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new GoogleAuthError("Google did not return a refresh token; remove the app under Google account permissions and connect again", true);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, scope: t.scope ?? "" };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const t = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return { accessToken: t.access_token, expiresIn: t.expires_in };
}

/** Best effort: Google forgets the grant; failures are ignored because the local copy is deleted regardless. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(`${env().GOOGLE_OAUTH_BASE_URL.replace(/\/$/, "")}/revoke?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}
