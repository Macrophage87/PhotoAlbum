import { db } from "@/lib/db";
import { redeemPhoneLink } from "@/lib/auth/phone-link";

export const dynamic = "force-dynamic";

/**
 * The last step of connecting the app (see src/lib/auth/phone-link.ts): the code a signed-in member's yes produced,
 * with the secret only the asking app holds, in exchange for that phone's token. Nobody is signed in when this is
 * called; the pair is the proof. Every refusal reads the same, so a caller learns nothing about which half was wrong.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const { code, verifier } = (body && typeof body === "object" ? body : {}) as { code?: unknown; verifier?: unknown };
  const linked = await redeemPhoneLink(db, code, verifier);
  if (!linked) {
    return Response.json({ error: "That sign-in has expired or was already used. Start again from the app." }, { status: 400 });
  }
  return Response.json({ token: linked.token, name: linked.name }, { headers: { "cache-control": "no-store" } });
}
