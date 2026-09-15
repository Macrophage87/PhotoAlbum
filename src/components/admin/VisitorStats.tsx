import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import type { ThingCount, VisitorStats as Stats } from "@/lib/visits/stats";
import { barLabel, plural, whenAgo } from "@/lib/visits/format";

const RANGES = [7, 30, 90];

/**
 * Who has been looking at the album, and at what.
 *
 * Two numbers run through the whole panel and mean different things. A *visit* is a page opened. A *visitor* is one
 * browser over the window: the closest the album can get to a person without following anybody about, and a floor
 * rather than a headcount — a relative who reads on their phone and again on a laptop counts twice, a couple sharing
 * one laptop counts once. The wording says so wherever the number appears, because a figure nobody can interpret is
 * worse than no figure.
 */
export function VisitorStats({ stats, enabled, retentionDays }: { stats: Stats; enabled: boolean; retentionDays: number }) {
  const kind = (k: "MEMBER" | "SHARE" | "PUBLIC") => stats.byKind.find((r) => r.kind === k) ?? { visits: 0, visitors: 0 };
  const family = kind("MEMBER");
  const link = kind("SHARE");
  const open = kind("PUBLIC");
  const busiest = Math.max(1, ...stats.daily.map((d) => d.visits));
  const quiet = stats.totals.visits === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold">Who has been looking</h2>
          <p className="text-sm text-muted mt-1">
            Counted on this server and shown only here. Nothing leaves the album, no addresses are kept, and every
            record is deleted after {plural(retentionDays, "day")}.
          </p>
        </div>
        <nav className="flex gap-1" aria-label="How far back">
          {RANGES.map((d) => (
            <Link
              key={d}
              href={`/admin?days=${d}#visitors`}
              aria-current={stats.days === d ? "page" : undefined}
              className={`rounded-theme px-2.5 py-1 text-sm border ${stats.days === d ? "border-primary bg-primary text-primary-fg" : "border-border hover:bg-surface-alt"}`}
            >
              {d} days
            </Link>
          ))}
        </nav>
      </div>

      {!enabled ? (
        <Card className="p-5 text-sm text-muted">
          Counting is off (VISITOR_STATS_ENABLED is false). Nothing has been recorded while it has been off; whatever
          is below was recorded before.
        </Card>
      ) : null}

      <Card className="p-5 space-y-4">
        <p className="text-sm" data-testid="visitor-summary">
          {quiet ? (
            <>Nobody has opened a page in the last {plural(stats.days, "day")}.</>
          ) : (
            <>
              <strong>{plural(stats.totals.visits, "page")}</strong> opened by{" "}
              <strong>{plural(stats.totals.visitors, "browser")}</strong> in the last {plural(stats.days, "day")}:{" "}
              {plural(family.visits, "page")} by family signed in, {plural(link.visits, "page")} on a secret link,{" "}
              {plural(open.visits, "page")} by anyone at all on something public.
            </>
          )}
        </p>

        {/* A browser is as close to a person as this gets; saying "people" would be a claim the album cannot make. */}
        <div className="flex items-end gap-px h-28" role="img" aria-label={`Pages opened each day for the last ${stats.days} days: ${stats.daily.map((d) => `${d.day}, ${d.visits}`).join("; ")}`}>
          {stats.daily.map((d) => (
            <div key={d.day} className="flex-1 min-w-0 flex flex-col justify-end h-full" title={`${barLabel(d.day)}: ${plural(d.visits, "page")}, ${plural(d.visitors, "browser")}`}>
              <div
                className={`rounded-t ${d.visits ? "bg-primary" : "bg-border"}`}
                style={{ height: `${d.visits ? Math.max(4, Math.round((d.visits / busiest) * 100)) : 2}%` }}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-between text-xs text-muted">
          <span>{stats.daily.length ? barLabel(stats.daily[0]!.day) : ""}</span>
          <span>{busiest > 1 ? `busiest day: ${plural(busiest, "page")}` : ""}</span>
          <span>today</span>
        </div>
        {stats.earliest && stats.earliest > stats.since && (
          <p className="text-xs text-muted">Counting began {whenAgo(stats.earliest)}, so this window is not yet full.</p>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Things title="Trips" rows={stats.trips} empty="No trip has been opened yet." />
        <Things title="Collections" rows={stats.collections} empty="No collection has been opened yet." />
      </div>

      {stats.items.length > 0 && (
        <Card className="p-5 space-y-3">
          <h3 className="font-medium">Photographs opened on their own page</h3>
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {stats.items.map((i) => (
              <li key={i.id} className="text-sm">
                <Link href={i.href} className="block group">
                  {i.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.thumbUrl} alt="" className="w-full h-24 object-cover rounded-theme border border-border" />
                  ) : (
                    <div className="w-full h-24 rounded-theme bg-surface-alt border border-border" />
                  )}
                  <div className="truncate group-hover:underline mt-1">{i.title}</div>
                </Link>
                <div className="text-muted text-xs">{plural(i.visits, "look")} by {plural(i.visitors, "browser")}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-5 space-y-2">
          <h3 className="font-medium">Arrived from</h3>
          {stats.referrers.length === 0 ? (
            <p className="text-sm text-muted">Nobody followed a link in from another site — people came straight here, or their browser kept it to itself.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {stats.referrers.map((r) => (
                <li key={r.host} className="flex justify-between gap-3">
                  <span className="truncate">{r.host}</span>
                  <span className="text-muted">{plural(r.visits, "page")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5 space-y-2">
          <h3 className="font-medium">Family</h3>
          <ul className="text-sm space-y-1" data-testid="visitor-members">
            {stats.members.map((m) => (
              <li key={m.id} className="flex justify-between gap-3">
                <span className="truncate">{m.name ?? m.email}</span>
                <span className="text-muted whitespace-nowrap">
                  {m.visits > 0 ? `${plural(m.visits, "page")}, ` : ""}
                  {m.last ? whenAgo(m.last) : "not since counting began"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

/** Trips or collections, most looked at first, with what a secret link accounted for called out separately. */
function Things({ title, rows, empty }: { title: string; rows: ThingCount[]; empty: string }) {
  return (
    <Card className="p-5 space-y-2">
      <h3 className="font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="text-sm space-y-2">
          {rows.map((t) => (
            <li key={t.id}>
              <div className="flex items-center gap-2">
                <Link href={t.href} className="font-medium text-primary hover:underline truncate">{t.title}</Link>
                {t.visibility && t.visibility !== "PRIVATE" && <Badge tone={t.visibility === "PUBLIC" ? "accent" : "neutral"}>{t.visibility === "PUBLIC" ? "public" : "link"}</Badge>}
              </div>
              <div className="text-muted text-xs">
                {plural(t.visits, "page")} by {plural(t.visitors, "browser")}
                {t.shareVisits > 0 ? `, ${t.shareVisits} on the secret link` : ""} · last {whenAgo(t.last)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
