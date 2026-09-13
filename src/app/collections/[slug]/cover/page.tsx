import { redirect } from "next/navigation";
import { requireCollectionOwnerPage } from "@/lib/collections/access";
import { collectionCoverFor } from "@/lib/collections/queries";
import { collectionCoverCandidates } from "@/lib/covers/candidates";
import { CoverPicker } from "@/components/covers/CoverPicker";
import { setCollectionCover } from "@/app/collections/actions";

export const metadata = { title: "Cover photo" };

export default async function CollectionCoverPage({ params, searchParams }: PageProps<"/collections/[slug]/cover">) {
  const { slug } = await params;
  const { collection } = await requireCollectionOwnerPage(slug, `/collections/${slug}/cover`);
  const sp = await searchParams;
  const after = typeof sp.after === "string" && sp.after ? sp.after : null;
  const [page, automatic] = await Promise.all([collectionCoverCandidates(collection.id, after), collectionCoverFor(collection)]);

  return (
    <CoverPicker
      title={collection.title}
      backHref={`/collections/${slug}/settings`}
      current={collection.coverPhoto}
      automatic={automatic}
      photos={page.photos}
      nextCursor={page.nextCursor}
      total={page.total}
      pageHref={`/collections/${slug}/cover`}
      choose={async (photoId: string) => {
        "use server";
        await setCollectionCover(slug, photoId);
        redirect(`/collections/${slug}/cover?chosen=1`);
      }}
      clear={async () => {
        "use server";
        await setCollectionCover(slug, null);
        redirect(`/collections/${slug}/cover`);
      }}
    />
  );
}
