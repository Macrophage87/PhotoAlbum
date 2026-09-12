import { notFound } from "next/navigation";
import { getSharedCollection } from "@/lib/share/queries";
import { listCollectionItems } from "@/lib/collections/queries";
import { PhotoGrid } from "@/components/photos/PhotoGrid";
import { toGridPhoto } from "@/components/photos/toGrid";

export default async function SharedCollectionPage({ params }: PageProps<"/share/c/[token]">) {
  const { token } = await params;
  const collection = await getSharedCollection(token);
  if (!collection) notFound();
  const items = await listCollectionItems(collection.id);
  return <PhotoGrid photos={items.filter((p) => p.status === "READY").map((p) => toGridPhoto(p))} emptyMessage="Nothing here yet." />;
}
