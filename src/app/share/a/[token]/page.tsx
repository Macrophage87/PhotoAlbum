import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getSharedActivity } from "@/lib/share/queries";
import { SHARE_COOKIE_PREFIX } from "@/lib/auth/viewer";
import { shareKey } from "@/lib/auth/access";
import { photoCardSelect } from "@/lib/photos/queries";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { TripTheme } from "@/themes/TripTheme";
import { ActivityDetail } from "@/components/activities/ActivityDetail";
import { ShareCookie } from "@/app/share/[token]/ShareCookie";
import { previewCard } from "@/lib/share/preview";
import { activityCover } from "@/lib/activities/cover";
import { formatDateTime } from "@/lib/time/format";

export async function generateMetadata({ params }: PageProps<"/share/a/[token]">): Promise<Metadata> {
  const { token } = await params;
  const activity = await getSharedActivity(token);
  if (!activity) return { title: "Shared activity", robots: { index: false, follow: false } };
  // The activity's cover stands in for it on a link preview — the one chosen for it, or else its first photograph.
  // It is fetched with the token, since whoever is unfurling the link holds no cookie.
  const cover = await activityCover(activity);
  const card = previewCard({
    title: activity.title,
    description: `${activity.trip.title} · ${formatDateTime(activity.startTime, activity.trip.timezone, "EEEE, MMMM d, yyyy")}`,
    pageUrl: new URL(`/share/a/${token}`, env().APP_URL).toString(),
    cover,
    appUrl: env().APP_URL,
    shareToken: token,
    shareKind: "activity",
  });
  return { title: activity.title, robots: { index: false, follow: false }, openGraph: card.openGraph, twitter: card.twitter };
}

/**
 * One activity, for whoever holds its link: the track, the stats, the charts and the photographs taken on it.
 *
 * Nothing else of the trip is reachable from here — no gallery, no timeline, no other activity — because the link
 * was made about this afternoon and not about the fortnight it sat in.
 */
export default async function SharedActivityLinkPage({ params }: PageProps<"/share/a/[token]">) {
  const { token } = await params;
  const activity = await getSharedActivity(token);
  if (!activity) notFound();
  const held = (await cookies()).get(`${SHARE_COOKIE_PREFIX}${shareKey("activity", activity.id)}`)?.value;
  if (held !== token) {
    return (
      <TripTheme themeKey={activity.trip.themeKey}>
        <ShareCookie kind="activity" id={activity.id} token={token} />
        <div className="min-h-[50vh] flex items-center justify-center text-muted">Opening shared activity…</div>
      </TripTheme>
    );
  }
  const photos = await db.photo.findMany({ where: { activityId: activity.id, ...NOT_TRASHED }, orderBy: [{ takenAt: "asc" }], select: photoCardSelect });
  return (
    <TripTheme themeKey={activity.trip.themeKey}>
      <div className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-12 flex items-center justify-between text-sm">
          <span className="font-display font-semibold">Family Album</span>
          <span className="text-muted">Shared with you</span>
        </div>
      </div>
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
        <ActivityDetail trip={activity.trip} activity={activity} photos={photos} editable={false} />
      </main>
    </TripTheme>
  );
}
