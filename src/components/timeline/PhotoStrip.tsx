import { PhotoGrid, type GridPhoto } from "@/components/photos/PhotoGrid";

export function PhotoStrip({ photos }: { photos: GridPhoto[] }) {
  return <PhotoGrid photos={photos} />;
}
