import { db } from "@/lib/db";
import { findInviteByToken } from "@/lib/auth/magic-link";
import { Card } from "@/components/ui";
import { SignInForm } from "@/app/auth/signin/SignInForm";

export const metadata = { title: "Invitation" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const invite = await findInviteByToken(token, { db });

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="w-full max-w-md p-8 space-y-6">
        {invite ? (
          <>
            <div>
              <h1 className="font-display text-2xl font-semibold">You&apos;re invited</h1>
              <p className="text-muted mt-1">
                This invitation is for <span className="font-medium text-text">{invite.email}</span>. Confirm it below and we&apos;ll email you a
                sign-in link.
              </p>
            </div>
            <SignInForm prefillEmail={invite.email} />
          </>
        ) : (
          <div>
            <h1 className="font-display text-2xl font-semibold">Invitation not found</h1>
            <p className="text-muted mt-1">This invite link is invalid, expired, or already used. Ask the person who invited you for a new one.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
