import { InlineUploader } from "@/components/photos/InlineUploader";

/**
 * Uploading straight into a collection from the collection's own page.
 *
 * A collection gathers photographs from anywhere — "Grandma's prints", "Christmas mornings" — and many of them
 * never had a trip to arrive through: a box of scans, a picture somebody emailed. They go into the collection as
 * they arrive, and onto a trip too if their dates match one, since a collection is a label rather than a place.
 */
export function CollectionUploader({ collectionId, maxClipSeconds, annotationActive }: { collectionId: string; maxClipSeconds: number; annotationActive: boolean }) {
  return (
    <InlineUploader
      target={{ collectionId }}
      openLabel="Upload photos to this collection"
      note="These go into this collection, and onto a trip as well if their dates match one. Anything the album already has is added here rather than copied."
      testId="collection-upload"
      maxClipSeconds={maxClipSeconds}
      annotationActive={annotationActive}
    />
  );
}
