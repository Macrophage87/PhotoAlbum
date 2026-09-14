import Link from "next/link";
import { Button } from "@/components/ui";
import { filterIsActive, KIND_LABELS, type GalleryFilter } from "@/lib/photos/filters";

export type FilterOption = { id: string; label: string };

const control = "h-9 rounded-theme border border-border bg-surface px-2 text-sm";

/**
 * Narrowing a gallery down: words to look for, and whichever of who/what/when/where-in-the-trip the page can offer.
 *
 * A plain form that submits to the page it is on, so the narrowed gallery is an ordinary address — one a member can
 * bookmark, send to a cousin, or reload without losing. No JavaScript is involved in any of it.
 */
export function GalleryFilters({ filter, action, members, activities, years, placeholder = "Search these photos" }: {
  filter: GalleryFilter;
  /** Where the form submits: the page's own path. */
  action: string;
  /** Members who uploaded something here; omitted for anonymous visitors, who never see who took what. */
  members?: FilterOption[];
  activities?: FilterOption[];
  years?: number[];
  placeholder?: string;
}) {
  const active = filterIsActive(filter);
  return (
    <form method="get" action={action} className="flex flex-wrap items-center gap-2" data-testid="gallery-filters">
      <label htmlFor="gallery-q" className="sr-only">{placeholder}</label>
      <input
        id="gallery-q"
        type="search"
        name="q"
        defaultValue={filter.q ?? ""}
        placeholder={placeholder}
        className={`${control} min-w-52 flex-1 max-w-sm`}
      />

      {members && members.length > 1 && (
        <select name="uploader" defaultValue={filter.uploaderId ?? ""} className={control} aria-label="Uploaded by">
          <option value="">Anyone</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      )}

      {activities && activities.length > 0 && (
        <select name="activity" defaultValue={filter.activityId ?? ""} className={control} aria-label="Activity">
          <option value="">Any activity</option>
          {activities.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
      )}

      {years && years.length > 1 && (
        <select name="year" defaultValue={filter.year ?? ""} className={control} aria-label="Year">
          <option value="">Any year</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      )}

      <select name="kind" defaultValue={filter.kind ?? ""} className={control} aria-label="Type">
        <option value="">Anything</option>
        {(Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((k) => (
          <option key={k} value={k}>{KIND_LABELS[k]}</option>
        ))}
      </select>

      <Button type="submit" variant="secondary" size="sm">Search</Button>
      {active && (
        <Link href={action} className="text-sm text-primary underline-offset-2 hover:underline" data-testid="clear-filters">
          Clear
        </Link>
      )}
    </form>
  );
}
