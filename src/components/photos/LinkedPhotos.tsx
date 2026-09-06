import Link from "next/link";
import { photoUrl } from "@/lib/photos/urls";
import { RELATION_LABEL } from "@/lib/photos/relations";
import type { PhotoRelation } from "@/generated/prisma/enums";

export type LinkedPhoto = { linkId: string; relation: PhotoRelation; note: string | null; other: { id: string; caption: string | null; originalName: string; updatedAt: Date; status: string } };

export function LinkedPhotos({ links, unlink }: { links: LinkedPhoto[]; unlink?: (linkId: string) => Promise<void> }) {
  if (!links.length) return null;
  return (
    <ul className="grid grid-cols-3 gap-2">
      {links.map((l) => (
        <li key={l.linkId} className="text-xs">
          <Link href={`/photos/${l.other.id}`} className="block aspect-square rounded overflow-hidden bg-surface-alt border border-border">
            {l.other.status === "READY" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoUrl(l.other, "thumb")} alt={l.other.caption ?? l.other.originalName} className="w-full h-full object-cover" />
            )}
          </Link>
          <div className="mt-1 flex items-start justify-between gap-1">
            <span className="text-muted">
              {RELATION_LABEL[l.relation]}
              {l.note ? ` · ${l.note}` : ""}
            </span>
            {unlink && (
              <form action={unlink.bind(null, l.linkId)}>
                <button type="submit" className="text-muted hover:text-red-600" title="Remove link">
                  ✕
                </button>
              </form>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
