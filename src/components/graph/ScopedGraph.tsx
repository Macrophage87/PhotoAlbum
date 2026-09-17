import Link from "next/link";
import type { Viewer } from "@/lib/auth/viewer";
import { graphPayload, type GraphScope } from "@/lib/graph/query";
import { MIN_SCORE } from "@/lib/graph/neighbours";
import { mlConfigured } from "@/lib/ml/client";
import { GraphViewDynamic } from "./GraphViewDynamic";

/**
 * One trip's or one collection's photographs, drawn by how alike they are.
 *
 * The same graph as the album-wide one, with the scope already decided by the page you are on — which is how it is
 * actually wanted: a family looking for the four nearly identical shots of the same puddle is looking inside one
 * trip, not across twenty years. The scoping container's own rules decide who may see it, and `graphPayload`
 * applies them again itself rather than trusting the page to have done so.
 */
export async function ScopedGraph({ viewer, scope, of }: { viewer: Viewer; scope: GraphScope; of: string }) {
  if (!mlConfigured()) {
    return <p className="text-muted">Similar photos need the optional local ML service, which the person who runs this album has not set up (see the README&apos;s server size section).</p>;
  }
  const data = await graphPayload(viewer, scope, MIN_SCORE);
  if (!data) return <p className="text-muted">Nothing to show here.</p>;
  if (data.nodes.length === 0) {
    return <p className="text-muted">Nothing in {of} has been looked at yet. The album works out what a photograph looks like in the background after it is uploaded.</p>;
  }
  if (data.nodes.length === 1) {
    return <p className="text-muted">Only one photograph in {of} has been looked at so far, so there is nothing yet for it to sit beside.</p>;
  }
  return (
    <>
      <GraphViewDynamic data={data} minScore={MIN_SCORE} />
      <p className="text-xs text-muted">
        Members only, and only the photographs you may see. <Link href="/privacy" className="underline">Privacy</Link>
      </p>
    </>
  );
}
