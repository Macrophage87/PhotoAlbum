import Link from "next/link";
import type { CollectionCardData } from "@/lib/collections/queries";
import { photoUrl } from "@/lib/photos/urls";
import { getTheme, themeToCssVars } from "@/themes";
import { Badge } from "@/components/ui";

const visibilityLabel = { PRIVATE: null, LINK: "Link", PUBLIC: "Public" } as const;

export function CollectionCard({ collection, cover, showVisibility }: { collection: CollectionCardData; cover: { id: string; updatedAt: Date } | null; showVisibility: boolean }) {
  const theme = getTheme(collection.themeKey);
  const vis = visibilityLabel[collection.visibility];
  return (
    <Link href={`/collections/${collection.slug}`} className="group block rounded-theme overflow-hidden border border-border bg-surface shadow-sm hover:shadow-md transition-shadow" style={themeToCssVars(theme)}>
      <div className="aspect-[4/3] bg-surface-alt relative overflow-hidden">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl(cover, "medium")} alt="" className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]" />
        ) : (
          <div className="w-full h-full" style={{ background: `linear-gradient(135deg, ${theme.palette.accent}, ${theme.palette.primary})` }} />
        )}
        {showVisibility && vis && (
          <Badge tone={collection.visibility === "PUBLIC" ? "success" : "warning"} className="absolute top-2 right-2 shadow">
            {vis}
          </Badge>
        )}
      </div>
      <div className="p-4">
        <h3 className="font-display text-lg font-semibold leading-tight" style={{ fontFamily: theme.fonts.display }}>
          {collection.title}
        </h3>
        {collection.description && <p className="text-sm text-muted mt-1 line-clamp-2">{collection.description}</p>}
        <p className="text-xs text-muted mt-2">
          {collection._count.items} photo{collection._count.items === 1 ? "" : "s"}
        </p>
      </div>
    </Link>
  );
}
