import { notFound } from "next/navigation";
import { getSharedCollection } from "@/lib/share/queries";
import { defaultCollectionOrder, listCollectionItems } from "@/lib/collections/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";

export default async function SharedCollectionPage({ params }: PageProps<"/share/c/[token]">) {
  const { token } = await params;
  const collection = await getSharedCollection(token);
  if (!collection) notFound();
  // In the order its owner arranged it, where they have; a shared link has no order of its own to offer.
  const items = await listCollectionItems(collection.id, { order: defaultCollectionOrder(collection) });
  return <PhotoGrid photos={items.filter((p) => p.status === "READY").map((p) => toGridPhoto(p))} emptyMessage="Nothing here yet." />;
}
