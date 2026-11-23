import { loadViewableCollection } from "@/lib/collections/access";
import { collectionSlides } from "@/lib/photos/slideshow";
import { Slideshow } from "@/components/slideshow/Slideshow";

export const metadata = { title: "Slideshow" };

export default async function CollectionSlideshowPage({ params }: PageProps<"/collections/[slug]/slideshow">) {
  const { slug } = await params;
  const { collection, editable } = await loadViewableCollection(slug, `/collections/${slug}/slideshow`);
  const slides = await collectionSlides(collection, editable);
  return <Slideshow title={collection.title} slides={slides} closeHref={`/collections/${slug}`} />;
}
