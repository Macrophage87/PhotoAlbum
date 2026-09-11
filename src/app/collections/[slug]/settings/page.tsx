import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/viewer";
import { env } from "@/lib/env";
import { getCollectionBySlug } from "@/lib/collections/queries";
import { shareableCollectionUrl } from "@/lib/share/social";
import { CollectionForm } from "@/components/collections/CollectionForm";
import { ShareButtons } from "@/components/trips/ShareButtons";
import { Button, Card, ConfirmSubmitButton } from "@/components/ui";
import { deleteCollection, rotateCollectionShareToken, setCollectionVisibility, updateCollection } from "../../actions";

const VISIBILITY = [
  { value: "PRIVATE", label: "Private", help: "Only signed-in family members can see this collection." },
  { value: "LINK", label: "Anyone with the link", help: "A secret link lets relatives without accounts view every photo in this collection, wherever it came from." },
  { value: "PUBLIC", label: "Public", help: "Anyone can browse this collection without signing in, and it appears on the front page. Photos from private trips become visible too." },
] as const;

export default async function CollectionSettingsPage({ params, searchParams }: PageProps<"/collections/[slug]/settings">) {
  const { slug } = await params;
  const sp = await searchParams;
  await requireUser(`/collections/${slug}/settings`);
  const collection = await getCollectionBySlug(slug);
  if (!collection) notFound();
  const update = updateCollection.bind(null, slug);
  const visibility = setCollectionVisibility.bind(null, slug);
  const rotate = rotateCollectionShareToken.bind(null, slug);
  const remove = deleteCollection.bind(null, slug);
  const shareUrl = shareableCollectionUrl(collection, env().APP_URL);

  return (
    <div className="max-w-2xl space-y-10">
      {sp.saved && <p className="rounded-theme bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm p-3">Saved.</p>}
      <section>
        <h2 className="font-display text-xl font-semibold mb-4">Collection details</h2>
        <CollectionForm action={update} submitLabel="Save changes" initial={{ title: collection.title, description: collection.description ?? "", themeKey: collection.themeKey }} />
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold mb-4">Who can see this collection</h2>
        <form action={visibility} className="space-y-3">
          {VISIBILITY.map((v) => (
            <label key={v.value} className="flex gap-3 items-start rounded-theme border border-border p-3 cursor-pointer has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-ring">
              <input type="radio" name="visibility" value={v.value} defaultChecked={collection.visibility === v.value} className="mt-1" />
              <span>
                <span className="font-medium">{v.label}</span>
                <span className="block text-sm text-muted">{v.help}</span>
              </span>
            </label>
          ))}
          <Button type="submit" variant="secondary">Update visibility</Button>
        </form>
        {collection.visibility === "LINK" && shareUrl && (
          <Card className="mt-4 p-4 space-y-2">
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
          <Card className="mt-4 p-4 space-y-2">
            <div className="text-sm font-medium">Share</div>
            <code className="block text-xs break-all bg-surface-alt rounded p-2">{shareUrl}</code>
            <ShareButtons url={shareUrl} />
          </Card>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl font-semibold mb-2 text-red-700">Delete collection</h2>
        <p className="text-sm text-muted mb-3">The photos stay in the album and on their trips; only the collection goes.</p>
        <form action={remove}>
          <ConfirmSubmitButton variant="danger" confirmMessage={`Delete "${collection.title}"? Photos are kept. This cannot be undone.`}>Delete this collection</ConfirmSubmitButton>
        </form>
      </section>
    </div>
  );
}
