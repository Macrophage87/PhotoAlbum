import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/viewer";
import { safeNextPath } from "@/lib/auth/tokens";
import { Card } from "@/components/ui";
import { SignInForm } from "./SignInForm";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/auth/signin">) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const next = safeNextPath(sp.next, "") || undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  if (viewer.kind === "user") redirect(next ?? "/");

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="w-full max-w-md p-8 space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold">Family Album</h1>
          <p className="text-muted mt-1">Sign in with your email. No password needed.</p>
        </div>
        {error && (
          <p className="text-sm rounded-theme bg-amber-50 text-amber-900 border border-amber-200 p-3">
            {error === "expired" && "That link has expired. Request a new one below."}
            {error === "used" && "That link was already used. Request a new one below."}
            {error === "invalid" && "That link isn't valid. Request a new one below."}
          </p>
        )}
        <SignInForm next={next} />
      </Card>
    </div>
  );
}
