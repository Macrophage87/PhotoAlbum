import { getTheme } from "@/themes";
import { Badge } from "@/components/ui";
import { ShareButtons } from "@/components/trips/ShareButtons";

export function CollectionHeader({ collection, shareUrl }: { collection: { title: string; description: string | null; themeKey: string; visibility: "PRIVATE" | "LINK" | "PUBLIC"; _count: { items: number } }; shareUrl?: string | null }) {
  const theme = getTheme(collection.themeKey);
  const Art = theme.headerArt;
  return (
    <div className="relative">
      <div className="h-32 sm:h-44 overflow-hidden">
        <Art className="w-full h-full" />
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 -mt-10 relative">
        <div className="bg-surface/95 backdrop-blur rounded-theme border border-border shadow-sm p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">Collection</p>
              <h1 className="font-display text-3xl sm:text-4xl font-semibold leading-tight">{collection.title}</h1>
              <p className="text-muted mt-1">
                {collection._count.items} item{collection._count.items === 1 ? "" : "s"}
              </p>
            </div>
            {collection.visibility !== "PRIVATE" && (
              <div className="flex items-center gap-3">
                <Badge tone={collection.visibility === "PUBLIC" ? "success" : "warning"}>{collection.visibility === "PUBLIC" ? "Public" : "Shared by link"}</Badge>
                {shareUrl && <ShareButtons url={shareUrl} />}
              </div>
            )}
          </div>
          {collection.description && <p className="mt-3 max-w-3xl text-text/90">{collection.description}</p>}
        </div>
        {theme.motif && <div className="h-3 mt-3 rounded" style={{ backgroundImage: `url("${theme.motif.pattern}")`, backgroundRepeat: "repeat-x", backgroundPosition: "center", opacity: theme.motif.opacity }} />}
      </div>
    </div>
  );
}
