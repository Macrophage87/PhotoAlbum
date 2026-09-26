import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { checkMagicLink } from "@/lib/auth/magic-link";
import { safeNextPath } from "@/lib/auth/tokens";
import { Button, Card } from "@/components/ui";
import { confirmSignIn } from "./actions";

export const metadata = { title: "Sign in", robots: { index: false } };

/**
 * Where the emailed link lands. Opening it only looks at the token: mail scanners open links before the person does,
 * so the link is used up by the button below (a POST), never by the visit itself.
 */
export default async function VerifyPage({ searchParams }: PageProps<"/auth/verify">) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const next = safeNextPath(sp.next);
  const check = await checkMagicLink(token, { db });
  if (!check.ok) redirect(`/auth/signin?error=${check.reason}`);

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="w-full max-w-md p-8 space-y-6 text-center">
        <div>
          <h1 className="font-display text-2xl font-semibold">Family Album</h1>
          <p className="text-muted mt-1">Press the button to finish signing in.</p>
        </div>
        <form action={confirmSignIn}>
          <input type="hidden" name="token" value={token} />
          {next !== "/" && <input type="hidden" name="next" value={next} />}
          <Button type="submit" size="lg" className="w-full h-16 text-xl">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
