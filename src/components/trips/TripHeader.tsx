import { getTheme } from "@/themes";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";
import { Badge } from "@/components/ui";
import { ShareButtons } from "./ShareButtons";

export function TripHeader({ trip, shareUrl }: { trip: { title: string; description: string | null; startDate: Date; endDate: Date; themeKey: string; visibility: "PRIVATE" | "LINK" | "PUBLIC" }; shareUrl?: string | null }) {
  const theme = getTheme(trip.themeKey);
  const Art = theme.headerArt;
  return (
    <div className="relative">
      <div className="h-40 sm:h-56 overflow-hidden">
        <Art className="w-full h-full" />
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 -mt-10 relative">
        <div className="bg-surface/95 backdrop-blur rounded-theme border border-border shadow-sm p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="font-display text-3xl sm:text-4xl font-semibold leading-tight">{trip.title}</h1>
              <p className="text-muted mt-1">{formatDayRange(dateColumnToDay(trip.startDate), dateColumnToDay(trip.endDate))}</p>
            </div>
            {trip.visibility !== "PRIVATE" && (
              <div className="flex items-center gap-3">
                <Badge tone={trip.visibility === "PUBLIC" ? "success" : "warning"}>{trip.visibility === "PUBLIC" ? "Public" : "Shared by link"}</Badge>
                {shareUrl && <ShareButtons url={shareUrl} />}
              </div>
            )}
          </div>
          {trip.description && <p className="mt-3 max-w-3xl text-text/90">{trip.description}</p>}
        </div>
        {theme.motif && <div className="h-3 mt-3 rounded" style={{ backgroundImage: `url("${theme.motif.pattern}")`, backgroundRepeat: "repeat-x", backgroundPosition: "center", opacity: theme.motif.opacity }} />}
      </div>
    </div>
  );
}
