import { getViewer, requireUser } from "@/lib/auth/viewer";
import { appScheme, isChallenge } from "@/lib/auth/phone-link";
import { deviceName } from "@/lib/auth/device-token";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Button, Card, buttonClasses } from "@/components/ui";
import { connectPhone } from "../actions";

export const metadata = { title: "Connect your phone" };

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Where the album's app sends a member to sign in. They sign in as they always do (the sign-in page brings them
 * back here), say yes, and are handed back to the app with a one-time code. See src/lib/auth/phone-link.ts.
 */
export default async function ConnectPhonePage({ searchParams }: PageProps<"/account/phone">) {
  const sp = await searchParams;
  const challenge = one(sp.challenge);
  const code = one(sp.code);
  const app = appScheme(one(sp.app));
  const name = deviceName(one(sp.name));
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ challenge, name: one(sp.name), app: one(sp.app), code })) if (value) query.set(key, value);
  const me = await requireUser(`/account/phone${query.size ? `?${query}` : ""}`);
  const viewer = await getViewer();
  const who = me.name ? `${me.name} (${me.email})` : me.email;

  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-xl space-y-6">
        <h1 className="font-display text-3xl font-semibold">Connect your phone</h1>
        {code && /^[A-Za-z0-9_-]{43}$/.test(code) ? (
          <Card className="p-5 space-y-4">
            <p>Almost done. Go back to the app to finish signing in.</p>
            {/* A link the member taps, not a redirect: the browser hands a link to the app, and a redirect to an
                address that is not a web page is something browsers and this site's own policy both refuse. */}
            <a href={`${app}://connect?code=${code}`} className={buttonClasses("primary", "lg")}>Back to the Family Album app</a>
            <p className="text-sm text-muted">This works for ten minutes, once, and only in the app that asked.</p>
          </Card>
        ) : isChallenge(challenge) ? (
          <Card className="p-5 space-y-4">
            <p>
              The Family Album app on <strong>{name}</strong> is asking to sign in as <strong>{who}</strong>.
            </p>
            <p className="text-sm text-muted">It will be able to add photos and videos to the album as you. You can sign the phone out at any time from Your account.</p>
            <form action={connectPhone} className="flex flex-wrap gap-3">
              <input type="hidden" name="challenge" value={challenge} />
              <input type="hidden" name="app" value={app} />
              <input type="hidden" name="name" value={name} />
              <Button type="submit" size="lg">Connect this phone</Button>
            </form>
            <p className="text-sm text-muted">Not you, or not your phone? Close this page and nothing happens.</p>
          </Card>
        ) : (
          <Card className="p-5">
            <p>This page is opened by the Family Album app. Open the app on your phone and choose Sign in.</p>
          </Card>
        )}
      </Container>
    </AppShell>
  );
}
