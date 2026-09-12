import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/viewer";
import { env } from "@/lib/env";
import { getCollectionBySlug } from "@/lib/collections/queries";
import { shareableCollectionUrl } from "@/lib/share/social";
import { CollectionForm } from "@/components/collections/CollectionForm";
import { ShareButtons } from "@/components/trips/ShareButtons";
import { Button, Card, ConfirmSubmitButton } from "@/components/ui";
import { deleteCollection, detachExposedFromOtherCollections, rotateCollectionShareToken, updateCollection } from "../../actions";
import { OptOutToggle } from "@/components/annotation/OptOutToggle";
import { visibilityWarnings } from "@/lib/visibility/settings";
import Link from "next/link";

const VISIBILITY = [
  { value: "PRIVATE", label: "Private", help: "Only signed-in family members can see this collection." },
  { value: "LINK", label: "Anyone with the link", help: "A secret link lets relatives without accounts view every photo in this collection, wherever it came from." },
  { value: "PUBLIC", label: "Public", help: "Anyone can browse this collection without signing in, and it appears on the front page. Photos from private trips become visible too." },
] as const;

export default async function CollectionSettingsPage({ params, searchParams }: PageProps<"/collections/[slug]/settings">) {
  const { slug } = await params;
  const sp = await searchParams;
  const me = await requireUser(`/collections/${slug}/settings`);
  const collection = await getCollectionBySlug(slug);
  if (!collection) notFound();
  const update = updateCollection.bind(null, slug);
  const rotate = rotateCollectionShareToken.bind(null, slug);
  const remove = deleteCollection.bind(null, slug);
  const shareUrl = shareableCollectionUrl(collection, env().APP_URL);
  const warnings = await visibilityWarnings("collection", collection.id, collection.visibility, "this collection");

  return (
    <div className="max-w-2xl space-y-10">
      {sp.saved && <p className="rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm p-3">Saved.</p>}
      <section>
        <h2 className="font-display text-xl font-semibold mb-4">Collection details</h2>
        <CollectionForm
          action={update}
          submitLabel="Save changes"
          initial={{ title: collection.title, description: collection.description ?? "", themeKey: collection.themeKey }}
          visibility={{ current: collection.visibility, legend: "Who can see this collection", options: VISIBILITY.map((v) => ({ ...v, warnings: warnings.byTarget[v.value] })) }}
        />
      </section>

      <section className="space-y-4">
        {warnings.stillExposed.length > 0 && (
          <Card className="p-4 space-y-2 border-amber-300 bg-amber-50 text-amber-900">
            <div className="text-sm font-medium">Still visible elsewhere</div>
            {warnings.stillExposed.map((line) => (
              <p key={line} className="text-sm">{line}</p>
            ))}
            <p className="text-sm">Visibility is a union: an item can be seen by anyone who may open its trip or any collection holding it.</p>
            <div className="flex flex-wrap gap-3 items-center">
              {warnings.exposingContainers.some((c) => c.kind === "collection") && (
                <form action={detachExposedFromOtherCollections.bind(null, slug)}>
                  <Button type="submit" variant="secondary" size="sm">{collection.visibility === "PRIVATE" && !warnings.exposingContainers.some((c) => c.kind === "trip") ? "Make these items private everywhere (remove them from those collections)" : "Remove these items from the more visible collections"}</Button>
                </form>
              )}
              {warnings.exposingContainers.filter((c) => c.kind === "collection").map((c) => (
                <Link key={`${c.kind}_${c.id}`} href={`/collections/${c.slug}/settings`} className="text-sm underline underline-offset-2">Open {c.title}</Link>
              ))}
            </div>
            {warnings.exposingContainers.some((c) => c.kind === "trip") && (
              <div className="flex flex-wrap gap-3 items-center">
                <span className="text-sm">Items on a more visible trip stay visible through that trip; change it from its settings:</span>
                {warnings.exposingContainers.filter((c) => c.kind === "trip").map((c) => (
                  <Link key={`${c.kind}_${c.id}`} href={`/trips/${c.slug}/settings`} className="text-sm underline underline-offset-2">Open {c.title}</Link>
                ))}
              </div>
            )}
          </Card>
        )}
        {warnings.alsoElsewhere > 0 && warnings.stillExposed.length === 0 && (
          <p className="text-sm text-muted">{warnings.alsoElsewhere} of this collection&apos;s {warnings.total} photos are also on a trip or in another collection; changing visibility here does not change theirs.</p>
        )}
        {collection.visibility === "LINK" && shareUrl && (
          <Card className="p-4 space-y-2">
            <div className="text-sm font-medium">Share link</div>
            <code className="block text-xs break-all bg-surface-alt rounded p-2">{shareUrl}</code>
            <div className="flex flex-wrap gap-2">
              <form action={rotate}>
                <Button type="submit" variant="secondary" size="sm">Generate a new link (old link stops working)</Button>
              </form>
              <ShareButtons url={shareUrl} />
            </div>
            <p className="text-xs text-muted">Anyone who sees the link can open the collection, so prefer a private group or message.</p>
          </Card>
        )}
        {collection.visibility === "PUBLIC" && shareUrl && (
          <Card className="p-4 space-y-2">
            <div className="text-sm font-medium">Share</div>
            <code className="block text-xs break-all bg-surface-alt rounded p-2">{shareUrl}</code>
            <ShareButtons url={shareUrl} />
          </Card>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold mb-2">AI descriptions</h2>
        <OptOutToggle target={{ kind: "collection", id: collection.id }} initial={collection.annotationOptOut} />
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold mb-2 text-red-700">Delete collection</h2>
        {me.role === "ADMIN" ? (
          <>
            <p className="text-sm text-muted mb-3">The photos stay in the album and on their trips; only the collection goes.</p>
            <form action={remove}>
              <ConfirmSubmitButton variant="danger" confirmMessage={`Delete "${collection.title}"? Photos are kept. This cannot be undone.`}>Delete this collection</ConfirmSubmitButton>
            </form>
          </>
        ) : (
          <p className="text-sm text-muted">Only an admin can delete a collection. Photos are never deleted with it.</p>
        )}
      </section>
    </div>
  );
}
