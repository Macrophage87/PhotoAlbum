"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

/**
 * What the family sees when a page fails to render.
 *
 * Two audiences, and they want opposite things. Whoever is looking at photographs wants to know that nothing is
 * broken for good and what to press; whoever runs the album wants the one string that finds the real error.
 *
 * That string is the digest. When a server render throws, the browser is told only "Minified React error #441" —
 * React withholds the message on purpose, so that a stack trace from a server never reaches a stranger's phone —
 * and the real error, with the digest beside it, is written to the server's own log. Printing the digest here is
 * what turns "it broke" into a line somebody can actually search for.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex-1 flex items-center justify-center p-10 text-center">
      <div className="max-w-md space-y-4">
        <h1 className="font-display text-3xl font-semibold">Something went wrong</h1>
        <p className="text-muted">
          Nothing has been lost — this page could not be drawn, that is all. Try it again, and if it keeps happening,
          reload the page.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>
        {/* A client-side failure has no digest and no server log; there its own message is all there is to go on. */}
        {!error.digest && error.message && <p className="text-sm text-muted break-words">{error.message}</p>}
        {error.digest && (
          <p className="text-sm text-muted">
            If you tell whoever runs the album, give them this reference:{" "}
            <code className="font-mono text-text" data-testid="error-digest">
              {error.digest}
            </code>
            <br />
            The error itself is in the server&apos;s log beside that reference.
          </p>
        )}
      </div>
    </div>
  );
}
