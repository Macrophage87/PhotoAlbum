import Link from "next/link";
import { Button } from "@/components/ui";
import { advancedIsActive, filterIsActive, KIND_LABELS, type GalleryFilter } from "@/lib/photos/filters";
import type { FilterPerson } from "@/lib/people/in-photos";

export type FilterOption = { id: string; label: string };

const control = "h-9 rounded-theme border border-border bg-surface px-2 text-sm";
const field = "flex flex-col gap-1 text-sm";
const fieldLabel = "text-xs text-muted";

/**
 * Narrowing a gallery, a timeline or a map down to what somebody is actually looking for.
 *
 * Most of the time the answer is a word or two, so that is all the form shows: a box and a button. The rest — who
 * uploaded it, who is in it, what kind of thing it is, which year, which part of the trip — waits behind "More ways
 * to narrow", which opens itself whenever one of them is already set, so a narrowed link arrives showing why.
 *
 * A plain form that submits to the page it is on, so the narrowed page is an ordinary address — one a member can
 * bookmark, send to a cousin, or reload without losing. No JavaScript is involved in any of it.
 */
export function GalleryFilters({ filter, action, members, people, activities, years, placeholder = "Search these photos", hidden }: {
  filter: GalleryFilter;
  /** Where the form submits: the page's own path. */
  action: string;
  /** Members who uploaded something here; omitted for anonymous visitors, who never see who took what. */
  members?: FilterOption[];
  /** People and pets who are on something here; omitted for anonymous visitors for the same reason. */
  people?: FilterPerson[];
  activities?: FilterOption[];
  years?: number[];
  placeholder?: string;
  /** Anything else the address is already saying that this form must not drop, such as which collection is shown. */
  hidden?: Record<string, string>;
}) {
  const active = filterIsActive(filter);
  const keep = new URLSearchParams(hidden ?? {}).toString();
  const humans = (people ?? []).filter((p) => p.kind === "HUMAN");
  const pets = (people ?? []).filter((p) => p.kind === "PET");
  const hasMore = Boolean((members && members.length > 1) || humans.length || pets.length || (activities && activities.length) || (years && years.length > 1));

  return (
    <form method="get" action={action} className="space-y-2" data-testid="gallery-filters">
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="gallery-q" className="sr-only">{placeholder}</label>
        <input id="gallery-q" type="search" name="q" defaultValue={filter.q ?? ""} placeholder={placeholder} className={`${control} min-w-52 flex-1 max-w-sm`} />
        <Button type="submit" variant="secondary" size="sm">Search</Button>
        {active && (
          <Link href={keep ? `${action}?${keep}` : action} className="text-sm text-primary underline-offset-2 hover:underline" data-testid="clear-filters">
            Clear
          </Link>
        )}
      </div>

      {hasMore && (
        <details open={advancedIsActive(filter)} data-testid="advanced-filters">
          <summary className="text-sm text-muted cursor-pointer select-none w-fit">More ways to narrow</summary>
          <div className="flex flex-wrap items-end gap-3 pt-3">
            {members && members.length > 1 && (
              <div className={field}>
                {/* Said plainly, because a bare "Anyone" beside a search box tells nobody what it is choosing. */}
                <label className={fieldLabel} htmlFor="gallery-uploader">Uploaded by</label>
                <select id="gallery-uploader" name="uploader" defaultValue={filter.uploaderId ?? ""} className={control}>
                  <option value="">Anyone</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}

            {(humans.length > 0 || pets.length > 0) && (
              <div className={field}>
                <label className={fieldLabel} htmlFor="gallery-person">Who is in it</label>
                <select id="gallery-person" name="person" defaultValue={filter.personId ?? ""} className={control} data-testid="who-filter">
                  <option value="">Anybody</option>
                  {humans.length > 0 && (
                    <optgroup label="People">
                      {humans.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {pets.length > 0 && (
                    <optgroup label="Pets">
                      {pets.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            )}

            {activities && activities.length > 0 && (
              <div className={field}>
                <label className={fieldLabel} htmlFor="gallery-activity">Part of the trip</label>
                <select id="gallery-activity" name="activity" defaultValue={filter.activityId ?? ""} className={control}>
                  <option value="">Any activity</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
              </div>
            )}

            {years && years.length > 1 && (
              <div className={field}>
                <label className={fieldLabel} htmlFor="gallery-year">Year</label>
                <select id="gallery-year" name="year" defaultValue={filter.year ?? ""} className={control}>
                  <option value="">Any year</option>
                  {years.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            )}

            <div className={field}>
              <label className={fieldLabel} htmlFor="gallery-kind">Type</label>
              <select id="gallery-kind" name="kind" defaultValue={filter.kind ?? ""} className={control}>
                <option value="">Anything</option>
                {(Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>

            <Button type="submit" variant="secondary" size="sm">Search</Button>
          </div>
        </details>
      )}

      {/* With nothing else to offer, the type is the only extra question and it rides along with the words. */}
      {!hasMore && (
        <div className="flex flex-wrap items-center gap-2">
          <label className={fieldLabel} htmlFor="gallery-kind">Type</label>
          <select id="gallery-kind" name="kind" defaultValue={filter.kind ?? ""} className={control}>
            <option value="">Anything</option>
            {(Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>
      )}
    </form>
  );
}
