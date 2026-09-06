import Link from "next/link";
import type { TripCardData } from "@/lib/trips/queries";
import { photoUrl } from "@/lib/photos/urls";
import { formatDayRange } from "@/lib/time/format";
import { dateColumnToDay } from "@/lib/time/local-day";
import { getTheme, themeToCssVars } from "@/themes";
import { Badge } from "@/components/ui";

const visibilityLabel = { PRIVATE: null, LINK: "Link", PUBLIC: "Public" } as const;

export function TripCard({ trip, cover, showVisibility }: { trip: TripCardData; cover: { id: string; updatedAt: Date } | null; showVisibility: boolean }) {
  const theme = getTheme(trip.themeKey);
  const vis = visibilityLabel[trip.visibility];
  return (
    <Link href={`/trips/${trip.slug}`} className="group block rounded-theme overflow-hidden border border-border bg-surface shadow-sm hover:shadow-md transition-shadow" style={themeToCssVars(theme)}>
      <div className="aspect-[4/3] bg-surface-alt relative overflow-hidden">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl(cover, "medium")} alt="" className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]" />
        ) : (
          <div className="w-full h-full" style={{ background: `linear-gradient(135deg, ${theme.palette.primary}, ${theme.palette.accent})` }} />
        )}
        {showVisibility && vis && (
          <Badge tone={trip.visibility === "PUBLIC" ? "success" : "warning"} className="absolute top-2 right-2 shadow">
            {vis}
          </Badge>
        )}
      </div>
      <div className="p-4">
        <h3 className="font-display text-lg font-semibold leading-tight" style={{ fontFamily: theme.fonts.display }}>
          {trip.title}
        </h3>
        <p className="text-sm text-muted mt-1">{formatDayRange(dateColumnToDay(trip.startDate), dateColumnToDay(trip.endDate))}</p>
        <p className="text-xs text-muted mt-2">
          {trip._count.photos} photo{trip._count.photos === 1 ? "" : "s"} · {trip._count.activities} activit{trip._count.activities === 1 ? "y" : "ies"}
        </p>
      </div>
    </Link>
  );
}
