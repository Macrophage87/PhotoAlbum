import Link from "next/link";
import { photoUrl } from "@/lib/photos/urls";

/** A small strip of look-alike items, already filtered by what the viewer may see. */
export function SimilarStrip({ items, graphHref }: { items: { photo: { id: string; updatedAt: Date; caption: string | null; title: string | null; originalName: string }; score: number }[]; graphHref?: string }) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Similar photos</h2>
        {graphHref && <Link href={graphHref} className="text-xs text-primary hover:underline">Open in the graph</Link>}
      </div>
      <ul className="flex gap-2 overflow-x-auto pb-1" data-testid="similar-strip">
        {items.map(({ photo, score }) => (
          <li key={photo.id} className="shrink-0">
            <Link href={`/photos/${photo.id}`} className="block w-24 h-24 rounded-theme overflow-hidden border border-border" title={`${Math.round(score * 100)}% alike`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl(photo, "thumb")} alt={photo.caption ?? photo.title ?? photo.originalName} className="w-full h-full object-cover" loading="lazy" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
