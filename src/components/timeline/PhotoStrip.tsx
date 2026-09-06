import { PhotoGrid, type GridPhoto } from "@/components/photos/PhotoGrid";

export function PhotoStrip({ photos, showDetailLink }: { photos: GridPhoto[]; showDetailLink: boolean }) {
  return <PhotoGrid photos={photos} showDetailLink={showDetailLink} />;
}
